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
 * Outbound HTTP for a plugin, held to the hostnames its manifest declares in
 * `network.outboundDomains`, on the first URL and on every redirect, and
 * under the server's outbound HTTP policy (#1083).
 *
 * A request to a host the manifest doesn't declare rejects with an error
 * whose `code` is `PLUGIN_OUTBOUND_DOMAIN_NOT_DECLARED`, so a plugin can tell
 * it apart without importing anything from the host. The client never asks
 * for compression: the `Response` is built from the bytes as they arrived.
 */
export interface PluginHttp {
  /** A property, not a method, so a plugin can hand it on by itself. */
  readonly fetch: (url: string, request: PluginHttpRequest) => Promise<Response>;
}
