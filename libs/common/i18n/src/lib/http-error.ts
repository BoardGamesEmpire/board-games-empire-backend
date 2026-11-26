import { t } from '@bge/i18n-core';
import type { Logger } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { Http } from '@status/codes';
import { CodedHttpException } from './coded-http.exception';

/**
 * An error from the `http-errors` package, which body-parser and Express raise
 * for a request they can't read. Every one carries `expose`, which is how it is
 * told apart from another library's error that only shares the status field,
 * such as better-auth's `APIError` (#527).
 */
export interface HttpError {
  /** `false` when the error's text must not reach the client. */
  readonly expose: boolean;

  readonly message: string;
  readonly statusCode: number;
}

/**
 * The answer to an `http-errors` error, with catalog copy and never the
 * error's own text (#527):
 *
 * - a body over the limit (body-parser's 413) is the coded refusal
 *   `REQUEST_TOO_LARGE`, the one `/api/auth` answers;
 * - any other request the parser or Express can't read keeps its 4xx status
 *   and says so, with no code. The error's own text goes to the log, as a
 *   warning: the request was the client's to fix;
 * - a 5xx, or an error marked unexposed, is logged and answered as a 500 with
 *   no code: it is the server's fault, and the client learns nothing about it.
 */
export function answerHttpError(error: HttpError, logger: Logger): HttpException {
  const status = error.statusCode;

  if (status === Http.PayloadTooLarge && error.expose) {
    return new CodedHttpException(status, 'REQUEST_TOO_LARGE', t('errors.request.too_large'), { cause: error });
  }

  if (status < Http.InternalServerError && error.expose) {
    logger.warn(`Refused a request the server couldn't read (${status}): ${error.message}`);
    return new HttpException(t('errors.request.unreadable'), status, { cause: error });
  }

  logger.error(error);
  return new HttpException(t('errors.request.failed'), Http.InternalServerError, { cause: error });
}

/**
 * The `http-errors` error behind an `HttpException` Nest made from one. Since
 * Nest 12, Express's error handler turns a 4xx `http-errors` error, such as
 * body-parser's 413, into an `HttpException` that keeps the parser's text and
 * the error as its `cause`, before any filter sees it.
 *
 * Malformed JSON and a path Express can't decode are left out: Nest answered
 * those as a `BadRequestException` before Nest 12 too, and their copy is
 * #1261's to decide.
 */
export function mappedHttpError(exception: HttpException): HttpError | undefined {
  const { cause } = exception;

  if (cause instanceof SyntaxError || cause instanceof URIError) {
    return undefined;
  }

  return isHttpError(cause) ? cause : undefined;
}

/**
 * A 4xx or 5xx `http-errors` error. Nest's own `isHttpError` reads any object
 * with a status and a message as one, which takes in better-auth's `APIError`
 * too: that is a server-side failure, not a request the client must fix (#527).
 */
export function isHttpError(error: unknown): error is HttpError {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  return (
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode < 600 &&
    'message' in error &&
    typeof error.message === 'string' &&
    'expose' in error &&
    typeof error.expose === 'boolean'
  );
}
