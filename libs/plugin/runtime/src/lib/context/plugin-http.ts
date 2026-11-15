import {
  HostNotAllowedError,
  RedirectToDisallowedTargetError,
  type SafeHttpResponse,
  type SecureHttpService,
} from '@bge/secure-http';
import type { PluginHttp, PluginHttpRequest } from '@boardgamesempire/plugin-contract';
import { PluginOutboundDomainNotDeclaredError, PluginOutboundDomainsNotSupportedError } from './context.errors';

/** Statuses whose Response may not carry a body, not even an empty one. */
const BODILESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * Builds a plugin's HTTP client (#1083): every request goes through the
 * server's `SecureHttpService`, so the outbound HTTP policy applies, and the
 * service asks `allowHost` on the first URL and on every redirect, so the
 * plugin is held to the hosts its manifest declares wherever a redirect
 * sends it.
 */
export function buildPluginHttp(
  slug: string,
  outboundDomains: readonly string[] | 'configured',
  secureHttp: Pick<SecureHttpService, 'request'>,
): PluginHttp {
  // The hosts of a `configured` plugin come from its configuration, which
  // this client can't hold it to yet, so it reaches nothing (#1293).
  if (outboundDomains === 'configured') {
    return {
      fetch: async (): Promise<Response> => {
        throw new PluginOutboundDomainsNotSupportedError(slug);
      },
    };
  }

  // Copied into a Set at construction, as the emit allowlist is: a later
  // mutation of the manifest object must not widen where the plugin may go.
  const declaredHosts: ReadonlySet<string> = new Set(outboundDomains.map(normaliseHostname));
  const allowHost = (hostname: string): boolean => declaredHosts.has(normaliseHostname(hostname));

  return {
    fetch: async (url: string, request: PluginHttpRequest): Promise<Response> => {
      let answer: SafeHttpResponse<ArrayBuffer>;
      try {
        answer = await secureHttp.request<ArrayBuffer>(url, {
          method: request.method,
          headers: withoutCompression(request.headers),
          body: request.body,
          signal: request.signal,
          responseType: 'arraybuffer',
          allowHost,
        });
      } catch (err) {
        // Only the host refusal becomes the plugin's own error; anything else
        // the service throws is already a coded SafeHttpError.
        const hostname = refusedHostname(err);
        throw hostname === undefined ? err : new PluginOutboundDomainNotDeclaredError(slug, hostname);
      }

      return toResponse(answer);
    },
  };
}

/**
 * The plugin's headers, asking for the identity encoding only. The service
 * returns the bytes as they arrived and never decompresses, so a compressed
 * answer would reach the plugin as a Response whose `json()` fails. Leaving
 * the header out isn't enough: with no Accept-Encoding a server may pick any
 * coding (#1083).
 */
function withoutCompression(headers: Readonly<Record<string, string>>): Record<string, string> {
  const kept = Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'accept-encoding');
  return { ...Object.fromEntries(kept), 'accept-encoding': 'identity' };
}

/** The hostname the plugin's host rule refused, on the first URL or a redirect; otherwise undefined. */
function refusedHostname(err: unknown): string | undefined {
  if (err instanceof HostNotAllowedError) {
    return err.host;
  }

  if (err instanceof RedirectToDisallowedTargetError && err.cause instanceof HostNotAllowedError) {
    return err.cause.host;
  }

  return undefined;
}

/**
 * Exact match after normalising: hostnames are case-insensitive, and
 * `api.example.com.` (rooted at the DNS root) names the same host as
 * `api.example.com`. No wildcard and no subdomain match: the manifest
 * validator accepts neither (#1083).
 */
function normaliseHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

function toResponse(answer: SafeHttpResponse<ArrayBuffer>): Response {
  const body = BODILESS_STATUSES.has(answer.status) ? null : answer.body;
  return new Response(body, { status: answer.status, headers: answer.headers });
}
