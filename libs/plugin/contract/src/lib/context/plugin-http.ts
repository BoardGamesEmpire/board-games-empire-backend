/**
 * One request a plugin makes through its HTTP client (#1083). Shaped like a
 * DataGateway driver's upstream request, so a data-gateway plugin can hand
 * its client to the driver as the driver's upstream fetch. This lib doesn't
 * import the gateway contract to say so: the shapes match structurally.
 */
export interface PluginHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;

  /** Aborts the request. */
  readonly signal?: AbortSignal;
}

/**
 * Outbound HTTP for a plugin, held to the hostnames its plugin manifest declares in
 * `network.outboundDomains`, on the first URL and on every redirect, and
 * under the server's outbound HTTP policy (#1083).
 *
 * The client never asks for compression: the `Response` is built from the
 * bytes as they arrived. It carries what `fetch`'s own would: the status as
 * it arrived, the `url` that answered, `redirected`, and each `Set-Cookie`
 * header by itself.
 *
 * A redirect to another origin (another declared host, another port, or
 * https down to http) goes on without the request's `authorization`,
 * `cookie` and `proxy-authorization` headers, as with `fetch`. Any other
 * header follows every redirect, a key in a header of its own included.
 */
export interface PluginHttp {
  /**
   * A property, not a method, so a plugin can hand it on by itself.
   *
   * Any HTTP status resolves. A request cancelled through its `signal`
   * rejects with the signal's reason, an `AbortError` unless the plugin gave
   * another, as with `fetch`. A request that fails rejects with an error
   * that carries a `code`, so a plugin can tell failures apart without
   * importing anything from the server, and names at most a hostname, never
   * the URL, which can carry a secret in its query (#1083):
   *  - `PLUGIN_OUTBOUND_DOMAIN_NOT_DECLARED`, with `hostname`: the request, or
   *    a redirect it was sent on, went to a host the plugin manifest doesn't
   *    declare;
   *  - `PLUGIN_OUTBOUND_DOMAINS_CONFIGURED_UNSUPPORTED`: the plugin manifest declares
   *    `configured` outbound domains, and every request is refused (#1293);
   *  - otherwise the outbound HTTP service's own code, such as
   *    `REQUEST_TIMEOUT`, `OUTBOUND_NETWORK_ERROR`, `SSRF_REJECTION` or
   *    `REDIRECT_DENIED`, with the `hostname` the plugin asked for, or
   *    `INVALID_REQUEST_URL` with a null `hostname` when the URL can't be
   *    parsed or names no host.
   */
  readonly fetch: (url: string, request: PluginHttpRequest) => Promise<Response>;
}
