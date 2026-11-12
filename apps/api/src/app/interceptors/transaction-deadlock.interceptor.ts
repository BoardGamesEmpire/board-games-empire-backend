import { isDeadlockError } from '@bge/database';
import { CodedHttpException, t, toErrorCode } from '@bge/i18n';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Http } from '@status/codes';
import { catchError, type Observable, throwError } from 'rxjs';

/** Pinned rather than read from the class, so the code survives a rename or minification. */
const DEADLOCK_NAME = 'TransactionDeadlockError';

/**
 * A deadlock that survived whatever retry its call site had, rendered as the
 * client's answer rather than as a bare 500 (#398).
 *
 * 409 because the state is curable and the cure is the caller's: nothing about
 * the request was wrong, a concurrent writer and this one wanted the same rows
 * in an order Postgres broke by aborting one of them. `retryable: true` says so
 * without the client having to parse copy. The code, `TRANSACTION_DEADLOCK`, is
 * derived from the class name with `toErrorCode`, as every plugin refusal's
 * code is (#1260).
 *
 * NOT 503: the service is available and the next attempt is likely to succeed,
 * and a 503 invites clients to back off from the whole API over one row.
 */
export class TransactionDeadlockError extends CodedHttpException {
  override readonly name = DEADLOCK_NAME;

  constructor(cause: unknown) {
    super(Http.Conflict, toErrorCode(DEADLOCK_NAME), t('errors.database.deadlock'), {
      fields: { retryable: true },
      cause,
    });
  }
}

/**
 * Turns a Postgres deadlock into {@link TransactionDeadlockError}, everywhere,
 * once.
 *
 * An INTERCEPTOR rather than an exception filter, deliberately. A deadlock
 * reaches the edge as a `PrismaClientKnownRequestError` whose code depends on
 * the losing statement — P2010 when it was raw, P2034 when it was a model write
 * — and up to `@prisma/adapter-pg@7.8` the model-write case escaped as a bare
 * `DriverAdapterError` (#398). That class is internal to the driver adapter,
 * so there is no constructor to hand `@Catch(...)`, and a filter on the Prisma
 * class alone would go blind again if the shape regressed — and the
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
 * interceptor chain. `HttpActorMiddleware`, `AbilityContextMiddleware`, and
 * `PoliciesGuard` all query the database, and a deadlock victim in one of
 * them still renders as a bare 500. Those paths are reads today, apart from
 * the one-row update verifying an API key makes in a statement of its own,
 * so a deadlock there needs a writer to contend with and has never been
 * observed; the honest statement is that this is the HTTP handler's answer,
 * not the whole request's.
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
