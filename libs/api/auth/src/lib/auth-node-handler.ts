import type { I18nPath } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import { getRequest, setResponse } from 'better-call/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { coded, markBodyCutOff, type AuthRequestHandler } from './auth-request-handler';

export interface AuthNodeHandlerOptions {
  /** The most bytes of a request body read, beyond which the request is refused. */
  readonly maxBodyBytes: number;
  /** Renders a refusal's catalog key. */
  readonly render: (key: I18nPath) => string;
}

/** The stable code a request whose body is over the limit carries (#1057). */
const REQUEST_TOO_LARGE = 'REQUEST_TOO_LARGE';

/** The stable code a request carries when its URL can't be worked out from its headers. */
const BAD_REQUEST = 'BAD_REQUEST';

/**
 * Serves `/api/auth/*` from node's request and response, as better-auth's
 * `toNodeHandler` does, with a limit on the body (#1057).
 *
 * better-auth's `toNodeHandler` reads every body with no limit (better-call
 * 1.4.4; still so in 1.4.5 and 2.0.6), so anyone, signed in or not, could
 * make the server hold an arbitrarily large body in memory. Here:
 *
 * - **A body that declares more than the limit is refused unread.** better-
 *   call's `getRequest` would throw on it, outside any handler, and Express
 *   would answer a bare 500.
 * - **Every other body better-call reads is read with the limit set,** so a
 *   chunked body is cut off as it grows past the limit, and the bytes it
 *   received are counted here. A request whose body passed the limit is
 *   refused in place of whatever the route answered. A cut-off read fails
 *   before the route runs, where better-call parses the body, or inside it,
 *   where the route reads the body itself, as app sign-in's token route does,
 *   and can answer 400; either way nothing was changed. The count doesn't
 *   depend on how the route surfaces it, nor on better-call's wording.
 * - **A body better-call doesn't read is not counted:** a GET's or HEAD's, or
 *   one with no `content-type`. The route answers without it, and node
 *   discards it once the answer is sent.
 * - **A route that answers before it reads the body keeps its answer,** as
 *   better-auth's router does for an unknown path, or its `onRequest` checks
 *   for a refusal. The route answered without the body, so its answer stands
 *   however much of the body arrives after it. No more of it is held:
 *   better-call stops keeping the body once it passes the limit, or, when the
 *   first chunk was smaller, pauses the request (#1197).
 *
 * The refusal is 413 `REQUEST_TOO_LARGE` with a plain-language message. It
 * keeps the connection, and node reads the rest of the body and discards it,
 * so no more of it is held. Closing instead would leave the client writing to
 * a closed socket, whose reset can throw away the refusal before the client
 * reads it.
 *
 * A request whose URL can't be built from its `Host` and
 * `X-Forwarded-Proto` is answered 400 `BAD_REQUEST`, where Express would
 * answer an uncoded 500.
 */
export function createAuthNodeHandler(
  handler: AuthRequestHandler,
  options: AuthNodeHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const logger = new Logger('AuthNodeHandler');
  const tooLarge = () => coded(413, REQUEST_TOO_LARGE, options.render('errors.request.too_large'));

  const refuse = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // A cut-off read leaves the request paused, which would stall the client.
    request.resume();
    await setResponse(response, tooLarge());
  };

  return async (request, response) => {
    if (Number(request.headers['content-length']) > options.maxBodyBytes) {
      return refuse(request, response);
    }

    let authRequest: Request;
    try {
      authRequest = getRequest({ request, base: baseUrl(request), bodySizeLimit: options.maxBodyBytes });
    } catch (error) {
      logger.warn(`Refused a request whose URL can't be built: ${error instanceof Error ? error.message : error}`);
      request.resume();

      return setResponse(response, coded(400, BAD_REQUEST, options.render('errors.auth.bad_request')));
    }

    // Counted only when better-call reads the body: it gives the request one
    // then, its reader attached in this same tick, before node emits a chunk.
    let received = 0;
    if (authRequest.body) {
      request.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > options.maxBodyBytes) {
          markBodyCutOff(authRequest);
        }
      });
    }

    let answer: Response;
    try {
      answer = await handler(authRequest);
    } catch (error) {
      // The api's handler answers every throw itself; a handler that lets a
      // cut-off read escape is still refused for the body.
      if (received > options.maxBodyBytes) {
        return refuse(request, response);
      }

      throw error;
    }

    if (received > options.maxBodyBytes) {
      await answer.body?.cancel();

      return refuse(request, response);
    }

    await setResponse(response, answer);
  };
}

/** The origin a request was sent to, worked out as better-call's `toNodeHandler` does. */
function baseUrl(request: IncomingMessage): string {
  const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
  const protocol = request.headers['x-forwarded-proto'] || (encrypted ? 'https' : 'http');

  return `${protocol}://${request.headers[':authority'] || request.headers.host}`;
}
