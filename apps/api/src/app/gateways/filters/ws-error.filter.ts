import { AuditContextService } from '@bge/actor-context';
import { type I18nTranslations, translateException, translateValidationErrors } from '@bge/i18n';
import { WsErrorEvents, type WsErrorPayload } from '@bge/shared';
import { ArgumentsHost, Catch, HttpException, Logger, WsExceptionFilter } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Http } from '@status/codes';
import { I18nService, I18nValidationException } from 'nestjs-i18n';
import type { Socket } from 'socket.io';
import { refuseSocket, wsErrorPayload, wsExceptionPayload, type WsFrame } from './ws-error-payload';

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
 * It is also where a frame's copy is translated (#180), as the global filters
 * do over HTTP: validation messages and `t()` markers, in the locale the
 * frame's CLS scope carries. Its own fixed copy for AuthGuard's refusals and
 * the 500 stays English, as those same refusals are over HTTP.
 *
 * No app-wide filter runs on a gateway message (Nest builds the WS exception
 * context without the application's global enhancers), so it is bound on
 * `AuthenticatedGateway`, and a gateway that does not extend it binds it
 * itself.
 */
@Catch()
export class WsErrorFilter implements WsExceptionFilter {
  private readonly logger = new Logger(WsErrorFilter.name);

  constructor(
    private readonly i18n: I18nService<I18nTranslations>,
    private readonly auditContext: AuditContextService,
  ) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ws = host.switchToWs();
    const client = ws.getClient<Socket>();
    const frame = { pattern: ws.getPattern(), data: ws.getData() };

    // Validation failures, and the refusals handlers throw. A 401 says the
    // session is gone however it was raised, so it ends the connection the way
    // AuthGuard's own does below.
    if (exception instanceof HttpException) {
      const payload = this.translatedPayload(exception, frame);
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

  /**
   * An HTTP exception's envelope, its copy translated in the frame's locale.
   *
   * An `I18nValidationException` keeps its messages on `errors`, and its body
   * is only the status text, so it is formatted from those. Anything else goes
   * through the same `translateException` the HTTP filter uses, which renders
   * a marker body, sends a marker whose copy cannot render as its key, and
   * leaves every other body as it is.
   *
   * Validation messages that cannot render (a template string-format rejects)
   * are logged, and the frame is answered with the exception's status and its
   * own message, the status text. Nest does not await this filter, so a throw
   * here would go unhandled and the frame would get no answer.
   */
  private translatedPayload(exception: HttpException, frame: WsFrame): WsErrorPayload {
    try {
      if (exception instanceof I18nValidationException) {
        const messages = translateValidationErrors(exception, this.i18n, this.auditContext);
        return wsErrorPayload(exception.getStatus(), messages, frame);
      }

      return wsExceptionPayload(translateException(exception, this.i18n, this.auditContext), frame);
    } catch (error) {
      this.logger.error(`Could not translate the ${exception.getStatus()} on ${frame.pattern}`, error);
      return wsErrorPayload(exception.getStatus(), exception.message, frame);
    }
  }
}
