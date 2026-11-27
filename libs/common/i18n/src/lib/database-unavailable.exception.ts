import { isDatabaseUnavailableError } from '@bge/database';
import { t } from '@bge/i18n-core';
import { Http } from '@status/codes';
import { CodedHttpException } from './coded-http.exception';
import type { ErrorCode } from './error-envelope';

/** The code a client branches on for a database outage (#1172). */
export const DATABASE_UNAVAILABLE = 'DATABASE_UNAVAILABLE' satisfies ErrorCode;

/**
 * The database couldn't be reached, or dropped the connection, so the request
 * wasn't completed (#1172). 503 because the service is down rather than the
 * request wrong, and trying again later may work.
 *
 * No `Retry-After` and no other field: the server can't know how long an
 * outage lasts. Distinct from `AUTH_UNAVAILABLE`, which says better-auth's
 * session storage failed, so a client mustn't treat itself as signed out.
 */
export class DatabaseUnavailableException extends CodedHttpException {
  constructor(cause: unknown) {
    super(Http.ServiceUnavailable, DATABASE_UNAVAILABLE, t('errors.database.unavailable'), { cause });
  }
}

/**
 * The 503 for a database outage, or `undefined` for any other error. Every edge
 * that answers an error it doesn't otherwise recognise asks this first: the
 * HTTP fallback filter, a WebSocket frame's filter and the handshake (#1172).
 */
export function asDatabaseUnavailable(error: unknown): DatabaseUnavailableException | undefined {
  return isDatabaseUnavailableError(error) ? new DatabaseUnavailableException(error) : undefined;
}
