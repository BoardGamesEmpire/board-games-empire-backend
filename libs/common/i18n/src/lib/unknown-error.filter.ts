import { t } from '@bge/i18n-core';
import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { Http } from '@status/codes';
import { CodedHttpException } from './coded-http.exception';
import { I18nExceptionFilter } from './i18n-exception.filter';

/**
 * An error from the `http-errors` package, which body-parser and Express raise
 * for a request they can't read. Every one carries `expose`, which is how it is
 * told apart from another library's error that only shares the status field,
 * such as better-auth's `APIError` (#527).
 */
interface HttpError {
  readonly statusCode: number;
  readonly message: string;
  /** `false` when the error's text must not reach the client. */
  readonly expose: boolean;
}

/**
 * The last-resort HTTP filter (#527, #1260): it answers everything that isn't
 * an `HttpException`, which Nest would otherwise answer itself with no `error`
 * field and English copy ("Internal server error", or body-parser's own text).
 * Every answer leaves as the error envelope with catalog copy, rendered in the
 * request locale, and never carries the thrower's own text:
 *
 * - a body over the limit (body-parser's 413) is the coded refusal
 *   `REQUEST_TOO_LARGE`, the one `/api/auth` answers;
 * - any other request body-parser or Express can't read keeps its 4xx status
 *   and says so, with no code. The parser's own text goes to the log, as a
 *   warning: the request was the client's to fix;
 * - anything else, a bug's `Error`, another library's error with a status, or
 *   an error marked unexposed, is logged and answered as a 500 with no code. An
 *   http-errors 5xx is logged too: it is the server's fault, and the client
 *   learns nothing about it.
 *
 * It turns the error into an `HttpException` and answers through the
 * `I18nExceptionFilter` it extends, so the two render alike, locale included:
 * body-parser's errors arrive before the locale middleware runs, and are
 * rendered in the request's `Accept-Language` locale. Registered via
 * `APP_FILTER` BEFORE `I18nExceptionFilter`, because Nest tries global filters
 * in reverse registration order: every `HttpException`, the validation 400
 * among them, still reaches its own filter first, and one that does reach this
 * filter is answered exactly as `I18nExceptionFilter` would. A malformed JSON
 * body never reaches it: Nest turns that parser error into a
 * `BadRequestException` before any filter runs (#1261).
 *
 * A response whose headers were already sent is ended rather than answered:
 * `BaseExceptionFilter` does that for the exception this filter hands it.
 */
@Catch()
export class UnknownErrorFilter extends I18nExceptionFilter {
  // Nest's own name for the log line it writes for an unhandled error.
  private readonly logger = new Logger('ExceptionsHandler');

  override catch(exception: unknown, host: ArgumentsHost): void {
    // A global filter never sees a WS host (see I18nExceptionFilter), so only
    // an `rpc` host lands here: Nest's own handling, untranslated.
    if (host.getType() !== 'http') {
      this.unhandled(exception, host);
      return;
    }

    this.render(this.toHttpException(exception), host);
  }

  private toHttpException(exception: unknown): HttpException {
    if (exception instanceof HttpException) {
      return exception;
    }

    if (isHttpError(exception)) {
      const status = exception.statusCode;

      if (status === Http.PayloadTooLarge && exception.expose) {
        return new CodedHttpException(status, 'REQUEST_TOO_LARGE', t('errors.request.too_large'), {
          cause: exception,
        });
      }

      if (status < Http.InternalServerError && exception.expose) {
        this.logger.warn(`Refused a request the server couldn't read (${status}): ${exception.message}`);
        return new HttpException(t('errors.request.unreadable'), status, { cause: exception });
      }
    }

    this.logger.error(exception);
    return new HttpException(t('errors.request.failed'), Http.InternalServerError, { cause: exception });
  }
}

/**
 * A 4xx or 5xx `http-errors` error. Nest's own `isHttpError` reads any object
 * with a status and a message as one, which takes in better-auth's `APIError`
 * too: that is a server-side failure, not a request the client must fix (#527).
 */
function isHttpError(error: unknown): error is HttpError {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  const { statusCode, message, expose } = error as Record<string, unknown>;
  return (
    typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 600 &&
    typeof message === 'string' &&
    typeof expose === 'boolean'
  );
}
