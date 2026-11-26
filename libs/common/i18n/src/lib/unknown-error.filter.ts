import { t } from '@bge/i18n-core';
import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { Http } from '@status/codes';
import { answerHttpError, isHttpError } from './http-error';
import { I18nExceptionFilter } from './i18n-exception.filter';

/**
 * The last-resort HTTP filter (#527, #1260): it answers everything that isn't
 * an `HttpException`, which Nest would otherwise answer itself with no `error`
 * field and English copy ("Internal server error", or body-parser's own text).
 * Every answer leaves as the error envelope with catalog copy, rendered in the
 * request locale, and never carries the thrower's own text:
 *
 * - an `http-errors` error thrown where Nest doesn't map it, inside a handler,
 *   is answered as {@link answerHttpError} says. Body-parser's errors no longer
 *   reach this filter: Nest maps them to an `HttpException` first, which
 *   `I18nExceptionFilter` answers the same way;
 * - anything else, a bug's `Error` or another library's error with a status,
 *   is logged and answered as a 500 with no code.
 *
 * It turns the error into an `HttpException` and answers through the
 * `I18nExceptionFilter` it extends, so the two render alike, locale included.
 * Registered via `APP_FILTER` BEFORE `I18nExceptionFilter`, because Nest tries
 * global filters in reverse registration order: every `HttpException`, the
 * validation 400 among them, still reaches its own filter first, and one that
 * does reach this filter is answered exactly as `I18nExceptionFilter` would.
 *
 * A response whose headers were already sent is ended rather than answered:
 * `BaseExceptionFilter` does that for the exception this filter hands it.
 */
@Catch()
export class UnknownErrorFilter extends I18nExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    // A global filter never sees a WS host (see I18nExceptionFilter), so only
    // an `rpc` host lands here: Nest's own handling, untranslated.
    if (host.getType() !== 'http') {
      this.unhandled(exception, host);
      return;
    }

    if (exception instanceof HttpException) {
      super.catch(exception, host);
      return;
    }

    this.render(this.toHttpException(exception), host);
  }

  private toHttpException(exception: unknown): HttpException {
    if (isHttpError(exception)) {
      return answerHttpError(exception, this.logger);
    }

    this.logger.error(exception);
    return new HttpException(t('errors.request.failed'), Http.InternalServerError, { cause: exception });
  }
}
