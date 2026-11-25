import type { IncomingMessage } from 'node:http';

/**
 * The requests that arrived on the operational port (#1511).
 *
 * One Express app answers both listeners, so a request carries nothing that
 * says which one accepted it. The operational listener marks each request here
 * before Express sees it, and this lib's controller reads the mark to tell the
 * two apart without reading the api's configuration: the port numbers live in
 * the api, and a peer can set any header it likes.
 *
 * A `WeakSet` holds the mark so a request leaves it when the request is
 * collected, and nothing outside this module can add or remove one.
 */
const operationalRequests = new WeakSet<IncomingMessage>();

/** Called only by the operational listener, for each request it accepts (#1511). */
export function markOperationalRequest(req: IncomingMessage): void {
  operationalRequests.add(req);
}

/** Whether the operational port accepted this request (#1511). */
export function isOperationalRequest(req: IncomingMessage): boolean {
  return operationalRequests.has(req);
}
