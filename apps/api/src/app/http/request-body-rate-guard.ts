import type { IncomingMessage, Server } from 'node:http';

/**
 * A plugin artifact upload may be 100 MiB from a slow connection, so a request
 * may take up to an hour (#1094): a 100 MiB body has to average about 29 KB/s
 * to finish in time. The rate floor below, not this limit, is what ends a
 * connection that has stopped sending.
 */
export const API_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

/** At least this many bytes must arrive in every window while a body is coming in. */
export const REQUEST_BODY_MIN_BYTES = 64 * 1024;
export const REQUEST_BODY_WINDOW_MS = 60_000;

export interface RequestBodyRateGuardOptions {
  minBytes?: number;
  windowMs?: number;
}

/**
 * Closes a connection whose request body stops arriving: fewer than `minBytes`
 * in a `windowMs` window, on every route (the better-auth handler is mounted
 * directly on Express and still sits behind the server's 'request' event). The
 * connection is destroyed without an answer, so the client sees a dropped
 * connection. That is deliberate: the request is stuck mid-body, so there is no
 * clean point to answer it.
 *
 * It watches until the body has arrived or the connection closes, whether or
 * not anything reads the body. After an early answer, such as a 401 or a 404
 * sent before the body was read, Node goes on draining the body, and a client
 * that trickles it would otherwise hold the connection for the whole request
 * timeout. Besides this floor, only the server's `requestTimeout` depends on
 * how fast a client is: the whole request must finish within it (#1094).
 *
 * A window in which the server held the body back is not counted. Until
 * something reads the body (an interceptor still checking authority before
 * the upload is read), or while a reader has paused it (a slow disk under an
 * upload), Node stops reading the socket, and a client sending at full speed
 * would read as one that stopped. The request timeout still bounds a body the
 * server holds.
 */
export function installRequestBodyRateGuard(server: Server, options: RequestBodyRateGuardOptions = {}): void {
  const minBytes = options.minBytes ?? REQUEST_BODY_MIN_BYTES;
  const windowMs = options.windowMs ?? REQUEST_BODY_WINDOW_MS;

  // Prepended, so it runs ahead of Express and every route sees it.
  server.prependListener('request', (req) => {
    // This header check and the `req.complete` check in the tick overlap on
    // purpose: either one alone keeps a request with no body from being cut off.
    if (!mayHaveBody(req)) {
      return;
    }

    // Each request on a keep-alive connection starts from its own count.
    const { socket } = req;
    let seen = socket.bytesRead;
    // Whether the server paused the body, or only began or went back to
    // reading it, in this window: either way it held the body for part of
    // the window, and the socket was not read while it did.
    let held = false;
    const onHoldChange = (): void => {
      held = true;
    };

    const timer = setInterval(() => {
      // `req.complete` is false at the 'request' event even for a request
      // with no body, so it is only trusted here, a window later.
      if (req.complete) {
        return stop();
      }

      const bytesRead = socket.bytesRead;
      const serverHeld = held || req.readableFlowing !== true || req.readableLength > 0;
      held = false;
      if (serverHeld) {
        seen = bytesRead;
        return;
      }

      if (bytesRead - seen < minBytes) {
        stop();
        socket.destroy();
        return;
      }

      seen = bytesRead;
    }, windowMs);
    timer.unref();

    function stop(): void {
      clearInterval(timer);
      req.off('end', stop);
      req.off('close', stop);
      req.off('pause', onHoldChange);
      req.off('resume', onHoldChange);
    }

    req.once('end', stop);
    req.once('close', stop);
    req.on('pause', onHoldChange);
    req.on('resume', onHoldChange);
  });
}

function mayHaveBody(req: IncomingMessage): boolean {
  const { 'content-length': length, 'transfer-encoding': encoding } = req.headers;

  return encoding !== undefined || (length !== undefined && Number(length) > 0);
}
