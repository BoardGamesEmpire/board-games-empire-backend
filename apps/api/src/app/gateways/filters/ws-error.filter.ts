import { WsErrorEvents } from '@bge/shared';
import { ArgumentsHost, Catch, HttpException, Logger, WsExceptionFilter } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Http } from '@status/codes';
import type { Socket } from 'socket.io';
import { refuseSocket, wsErrorPayload } from './ws-error-payload';

/**
 * Tells a WebSocket client why its frame failed, on one of the two
 * {@link WsErrorEvents} and in one envelope (#426), sent to the socket itself
 * rather than to a room it may not have joined.
 *
 * One filter catches everything, and branches on the exception's type. It is
 * not three `@Catch` filters because Nest tries a gateway's filters in reverse
 * declaration order and takes the first match: a catch-all beside narrower
 * filters has to be declared first, on every gateway, or it silently answers
 * every frame with a 500. A single filter has no order to get wrong.
 *
 * It has to be bound on each gateway. No app-wide filter runs on a gateway
 * message (Nest builds the WS exception context without the application's
 * global enhancers).
 */
@Catch()
export class WsErrorFilter implements WsExceptionFilter {
  private readonly logger = new Logger(WsErrorFilter.name);

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ws = host.switchToWs();
    const client = ws.getClient<Socket>();
    const frame = { pattern: ws.getPattern(), data: ws.getData() };

    // Validation failures, and the refusals handlers throw. A 401 says the
    // session is gone however it was raised, so it ends the connection the way
    // AuthGuard's own does below.
    if (exception instanceof HttpException) {
      const payload = wsErrorPayload(exception.getStatus(), messageOf(exception), frame);
      if (payload.statusCode === Http.Unauthorized) {
        await refuseSocket(client, payload);
        return;
      }

      client.emit(WsErrorEvents.Exception, payload);
      return;
    }

    // AuthGuard's two WS refusals. Only the missing session ends the
    // connection: a frame the client may not send says nothing about the next.
    if (exception instanceof WsException && exception.message === 'UNAUTHORIZED') {
      await refuseSocket(client, wsErrorPayload(Http.Unauthorized, 'Unauthorized', frame));
      return;
    }

    if (exception instanceof WsException && exception.message === 'FORBIDDEN') {
      client.emit(WsErrorEvents.Exception, wsErrorPayload(Http.Forbidden, 'Insufficient permissions', frame));
      return;
    }

    // Anything else is unexpected, a WsException with any other message
    // included: its text was written for whoever threw it, not for the client.
    this.logger.error(`Unhandled exception on ${frame.pattern}: socketId=${client.id}`, exception);
    client.emit(WsErrorEvents.Exception, wsErrorPayload(Http.InternalServerError, 'Internal server error', frame));
  }
}

/**
 * The message Nest's HTTP body would carry: a string body is the message
 * itself, and an object body (a `ValidationPipe` failure, `new
 * ConflictException('…')`) carries it as `message`.
 */
function messageOf(exception: HttpException): string | string[] {
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return body;
  }

  const { message } = body as { message?: string | string[] };
  return message ?? exception.message;
}
