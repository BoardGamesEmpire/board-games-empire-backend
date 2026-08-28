import { isDeadlockError } from '@bge/database';
import { t } from '@bge/i18n';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { HttpException, Injectable } from '@nestjs/common';
import { Http } from '@status/codes';
import { STATUS_CODES } from 'node:http';
import { catchError, type Observable, throwError } from 'rxjs';

/**
 * A deadlock that survived whatever retry its call site had, rendered as the
 * client's answer rather than as a bare 500 (#398, `D-398-2`).
 *
 * 409 because the state is curable and the cure is the caller's: nothing about
 * the request was wrong, a concurrent writer and this one wanted the same rows
 * in an order Postgres broke by aborting one of them. `retryable: true` says so
 * without the client having to parse copy, and the `code` is the class name, the
 * same dispatch contract every plugin refusal carries.
 *
 * NOT 503: the service is available and the next attempt is likely to succeed,
 * and a 503 invites clients to back off from the whole API over one row.
 */
export class TransactionDeadlockError extends HttpException {
  override readonly name = 'TransactionDeadlockError';

  constructor(cause: unknown) {
    super(
      {
        statusCode: Http.Conflict,
        error: STATUS_CODES[Http.Conflict],
        // Deferred marker: the global I18nExceptionFilter translates this in
        // place at the edge, leaving the machine-readable fields intact.
        message: t('errors.database.deadlock'),
        code: 'TransactionDeadlockError',
        retryable: true,
      },
      Http.Conflict,
      { cause },
    );
  }
}

/**
 * Turns a Postgres deadlock into {@link TransactionDeadlockError}, everywhere,
 * once.
 *
 * An INTERCEPTOR rather than an exception filter, deliberately. A deadlock
 * reaches the edge in two shapes (#398): a `PrismaClientKnownRequestError`
 * (P2010) when the losing statement was raw, and a bare `DriverAdapterError`
 * when it was an ordinary model write. That second class is internal to the
 * driver adapter, so there is no constructor to hand `@Catch(...)` — and the
 * alternative, a catch-all filter, would have to sit ahead of
 * `I18nExceptionFilter` and take over the rendering of every OTHER exception in
 * the app to reach this one. Converting in the error channel instead leaves that
 * chain exactly as it was: this throws an `HttpException` carrying a `t()`
 * marker, and the existing filters translate and render it like any other.
 *
 * Coverage, stated precisely rather than generously. Every controller and every
 * service reached through one is covered, including the paths with no deadlock
 * retry of their own — the quota consumers take their advisory locks inside a
 * caller-owned transaction, so retrying is that caller's decision and not
 * something this can make for them. Typed refusal is not the same as a retry; it
 * is what makes the refusal legible where the retry is absent or exhausted.
 *
 * What it does NOT cover: middleware and guards, which Nest runs BEFORE the
 * interceptor chain. `AbilityContextMiddleware`, `AuthGuard`, and `PoliciesGuard`
 * all query the database, and a deadlock victim in one of them still renders as a
 * bare 500. Those paths are reads today, so a deadlock there needs a writer to
 * contend with and has never been observed; the honest statement is that this is
 * the HTTP handler's answer, not the whole request's.
 */
@Injectable()
export class TransactionDeadlockInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() => (isDeadlockError(error) ? new TransactionDeadlockError(error) : error)),
        ),
      );
  }
}
