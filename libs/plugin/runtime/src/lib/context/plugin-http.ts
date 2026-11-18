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
        // The service reports a cancelled request as a network error. The
        // plugin cancelled on purpose and must be able to tell that from an
        // outage, so it gets its signal's own reason, as fetch gives. The
        // reason is the plugin's own value or the platform's AbortError, and
        // names no URL. A bug stays a bug (#1083).
        if (request.signal?.aborted && err instanceof SafeHttpError) {
          throw request.signal.reason;
        }

        throw toPluginError(slug, hostname, err);
      }

      return toResponse(answer);
    },
  };
}

/**
 * The host of the URL the plugin asked for. Node's parser puts the input on
 * the TypeError it throws, so a URL that can't be parsed becomes the
 * runtime's own error, naming no URL. A URL that parses but names no host,
 * such as `file:///x` or `mailto:`, is refused the same way: there is no host
 * to send it to, and none to name in a failure (#1083).
 */
function requestedHostname(slug: string, url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new PluginHttpRequestFailedError(slug, 'INVALID_REQUEST_URL', null);
  }

  if (hostname === '') {
    throw new PluginHttpRequestFailedError(slug, 'INVALID_REQUEST_URL', null);
  }

  return hostname;
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

/** What fetch reports of an answer and the Response constructor can't be given. */
interface FetchedFields {
  readonly redirected: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
}

function toResponse(answer: SafeHttpResponse<ArrayBuffer>): Response {
  // The service joins a repeated header with a comma, and joined cookies
  // can't be split again, so they come from its own list (#1083).
  const headers = new Headers(answer.headers);
  headers.delete('set-cookie');
  for (const cookie of answer.setCookie) {
    headers.append('set-cookie', cookie);
  }

  // The constructor throws a RangeError for a status outside 200 to 599, and
  // some upstreams answer with one (999 for a refused request). It is built
  // with a status it accepts, and `asFetched` puts the real one on it.
  const constructible = answer.status >= 200 && answer.status <= 599;
  const body = BODILESS_STATUSES.has(answer.status) ? null : answer.body;
  const response = new Response(body, { status: constructible ? answer.status : 200, headers });

  return asFetched(response, {
    status: answer.status,
    statusText: answer.statusText,
    url: answer.finalUrl,
    redirected: answer.redirectCount > 0,
  });
}

/**
 * Gives a built Response what fetch's own would carry: the status as it
 * arrived, whatever its range, the URL that answered and whether a redirect
 * led there. The constructor takes none of these, and a DataGateway driver
 * written against fetch reads them, to branch on a status or to resolve a
 * relative link against `response.url`. The reason phrase goes with them:
 * the constructor would take it, but throws on one it finds malformed, and
 * a driver reports it when a request fails (the IGDB driver's token request
 * does). They are set on the object itself,
 * over the prototype's getters, and `clone` is wrapped so a copy keeps them
 * (#1083).
 */
function asFetched(response: Response, fields: FetchedFields): Response {
  return Object.defineProperties(response, {
    status: { value: fields.status, enumerable: true },
    statusText: { value: fields.statusText, enumerable: true },
    ok: { value: fields.status >= 200 && fields.status <= 299, enumerable: true },
    url: { value: fields.url, enumerable: true },
    redirected: { value: fields.redirected, enumerable: true },
    clone: { value: (): Response => asFetched(Response.prototype.clone.call(response), fields) },
  });
}
