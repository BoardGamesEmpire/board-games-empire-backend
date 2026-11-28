import { AuditContextService } from '@bge/actor-context';
import { describeDatabaseError } from '@bge/database';
import type { I18nTranslations } from '@bge/i18n';
import {
  asDatabaseUnavailable,
  reasonPhrase,
  renderErrorBody,
  renderMarker,
  t,
  translateValidationErrors,
} from '@bge/i18n';
import type { WsErrorPayload } from '@bge/shared';
import { WsErrorEvents } from '@bge/shared';
import { ArgumentsHost, Catch, HttpException, Logger, WsExceptionFilter } from '@nestjs/common';
import { Http } from '@status/codes';
import { I18nService, I18nValidationException } from 'nestjs-i18n';
import type { Socket } from 'socket.io';
import type { WsFrame } from './ws-error-payload';
import { refuseSocket, wsErrorPayload, wsExceptionPayload } from './ws-error-payload';

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
 * do over HTTP: validation messages, `t()` markers and its own 500's copy,
 * the catalog copy the HTTP 500 carries (#527), in the locale the frame's CLS
 * scope carries. A database outage answers 503 `DATABASE_UNAVAILABLE`, as over
 * HTTP, and leaves the socket open: the session wasn't refused (#1172).
 *
 * No app-wide filter runs on a gateway message (Nest runs global guards,
 * interceptors and pipes on a frame, but builds its exception context without
 * the global filters), so it is bound on `AuthenticatedGateway`, and a gateway
 * that does not extend it binds it itself.
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

    // Validation failures, and the refusals guards and handlers throw. A 401
    // says the session is gone, so it ends the connection.
    if (exception instanceof HttpException) {
      const payload = this.translatedPayload(exception, frame);
      if (payload.statusCode === Http.Unauthorized) {
        await refuseSocket(client, payload);
        return;
      }

      client.emit(WsErrorEvents.Exception, payload);
      return;
    }

    // A database outage answers 503, as over HTTP, and the socket stays open.
    // Asked only after the HTTP exceptions, which keep their own answer even
    // when their cause is a driver error (#1172).
    const outage = asDatabaseUnavailable(exception);
    if (outage) {
      // Nest's `(message, stack)` form: nestjs-pino drops an `Error` argument.
      const { message, stack } =
        exception instanceof Error ? exception : { message: String(exception), stack: undefined };
      this.logger.error(
        `Database unavailable on ${frame.pattern}: socketId=${client.id}: ${message} (${describeDatabaseError(exception)})`,
        stack,
      );
      client.emit(WsErrorEvents.Exception, this.translatedPayload(outage, frame));
      return;
    }

    // Anything else is unexpected, a WsException included: its text was
    // written for whoever threw it, not for the client.
    this.logger.error(`Unhandled exception on ${frame.pattern}: socketId=${client.id}`, exception);
    const failed = renderMarker(t('errors.request.failed'), this.i18n, this.auditContext);
    client.emit(WsErrorEvents.Exception, wsErrorPayload(Http.InternalServerError, failed, frame));
  }

  /**
   * An HTTP exception's envelope, its copy translated in the frame's locale.
   *
   * An `I18nValidationException` keeps its messages on `errors`, and its body
   * is only the status text, so it is formatted from those. Anything else goes
   * through the same `renderErrorBody` the HTTP filter uses, which renders a
   * marker, sends a marker whose copy cannot render as its key, and reads
   * every body into the error envelope (#1260).
   *
   * Validation messages that cannot render (a template string-format rejects)
   * are logged, and the frame is answered with the exception's status and its
   * reason phrase. Never the exception's own message: a marker's names its key
   * and args, and some args carry request input. Nest does not await this
   * filter, so a throw here would go unhandled and the frame would get no
   * answer.
   */
  private translatedPayload(exception: HttpException, frame: WsFrame): WsErrorPayload {
    try {
      if (exception instanceof I18nValidationException) {
        const messages = translateValidationErrors(exception, this.i18n, this.auditContext);
        return wsErrorPayload(exception.getStatus(), messages, frame);
      }

      const status = exception.getStatus();
      return wsExceptionPayload(renderErrorBody(status, exception.getResponse(), this.i18n, this.auditContext), frame);
    } catch (error) {
      const status = exception.getStatus();
      this.logger.error(`Could not translate the ${status} on ${frame.pattern}`, error);
      return wsErrorPayload(status, reasonPhrase(status), frame);
    }
  }
}
