/** One request a DataGateway driver makes to its upstream (#1082). */
export interface UpstreamRequest {
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: string;

  /** Aborts the request. A driver passes one, so unsubscribing from its call stops the request (#1082). */
  signal?: AbortSignal;
}

/**
 * How a DataGateway driver reaches its upstream. A driver is handed one and
 * never calls the global `fetch`:
 *
 *  - a remote DataGateway's app passes Node's `fetch`;
 *  - a plugin DataGateway passes its context's scoped HTTP client (#1083),
 *    which keeps it to the outbound domains an admin consented to;
 *  - tests pass one that answers from recorded upstream fixtures.
 *
 * Deliberately narrower than `fetch`, so each of those has only this to
 * serve (#1082).
 */
export type UpstreamFetch = (url: string, request: UpstreamRequest) => Promise<Response>;

/**
 * Lets go of an answer's body the driver won't read, so the connection can be
 * reused. It never fails: a body already gone is let go of too (#1082).
 */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
