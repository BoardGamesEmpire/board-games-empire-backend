import type { UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';

/**
 * The UpstreamFetch a remote DataGateway's app hands its driver: Node's own
 * fetch. A plugin DataGateway is handed its context's scoped HTTP client
 * instead (#1082, #1083).
 */
export const nodeUpstreamFetch: UpstreamFetch = (url, request) => fetch(url, request);
