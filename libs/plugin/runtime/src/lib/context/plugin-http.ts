import {
  canonicalHostname,
  HostNotAllowedError,
  RedirectToDisallowedTargetError,
  SafeHttpError,
  type SafeHttpResponse,
  type SecureHttpService,
} from '@bge/secure-http';
import type { PluginHttp, PluginHttpRequest } from '@boardgamesempire/plugin-contract';
import {
  PluginHttpRequestFailedError,
  PluginOutboundDomainNotDeclaredError,
  PluginOutboundDomainsNotSupportedError,
} from './context.errors';

/** Statuses whose Response may not carry a body, not even an empty one. */
const BODILESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * Builds a plugin's HTTP client (#1083): every request goes through the
 * server's `SecureHttpService`, so the outbound HTTP policy applies, and the
 * service asks `allowHost` on the first URL and on every redirect, so the
 * plugin is held to the hosts its plugin manifest declares wherever a
 * redirect sends it.
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
  // mutation of the plugin manifest object must not widen where the plugin
  // may go. An exact match in the canonical form the outbound HTTP policy
  // compares its own lists in. No wildcard and no subdomain match: the
  // plugin manifest validator accepts neither (#1083).
  const declaredHosts: ReadonlySet<string> = new Set(outboundDomains.map(canonicalHostname));
  const allowHost = (hostname: string): boolean => declaredHosts.has(canonicalHostname(hostname));

  return {
    fetch: async (url: string, request: PluginHttpRequest): Promise<Response> => {
      const hostname = requestedHostname(slug, url);

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
        throw toPluginError(slug, hostname, err);
      }

      return toResponse(answer);
    },
  };
}

/**
 * The host of the URL the plugin asked for. Node's parser puts the input on
 * the TypeError it throws, so a URL that can't be parsed becomes the
 * runtime's own error, naming no URL (#1083).
 */
function requestedHostname(slug: string, url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new PluginHttpRequestFailedError(slug, 'INVALID_REQUEST_URL', null);
  }
}

/**
 * What the plugin sees of a failed request: only the runtime's own errors,
 * naming a host, never a URL. The service's error carries the whole URL, and
 * a redirect's target, so none of it is copied across, not even as `cause`.
 * Anything that isn't a SafeHttpError is a bug and propagates as it is
 * (#1083).
 */
function toPluginError(slug: string, hostname: string, err: unknown): unknown {
  const refused = refusedHostname(err);
  if (refused !== undefined) {
    return new PluginOutboundDomainNotDeclaredError(slug, refused);
  }

  if (err instanceof SafeHttpError) {
    return new PluginHttpRequestFailedError(slug, err.code, hostname);
  }

  return err;
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

function toResponse(answer: SafeHttpResponse<ArrayBuffer>): Response {
  const body = BODILESS_STATUSES.has(answer.status) ? null : answer.body;
  return new Response(body, { status: answer.status, headers: answer.headers });
}
