import { PG, PrismaError } from '@status/codes';

/** SQLSTATE `deadlock_detected`. Postgres chose a victim and aborted it. */
export const DEADLOCK_SQLSTATE: string = PG.DeadlockDetected;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * SQLSTATE out of a driver-adapter `cause`, whichever field carries it.
 *
 * `originalCode` is the field the adapter sets for every error it forwards and is
 * what {@link constraintIdentity} reads for the unique-violation case, so it is
 * preferred. `code` is the postgres passthrough copy, present because an error the
 * adapter has no mapped `kind` for arrives with the raw pg fields alongside — a
 * deadlock is one of those. Reading both means a driver release that keeps only
 * one of them still classifies.
 */
function sqlStateOf(cause: unknown): string | undefined {
  if (!isRecord(cause)) {
    return undefined;
  }

  const original = cause['originalCode'];

  if (typeof original === 'string') {
    return original;
  }

  const passthrough = cause['code'];

  return typeof passthrough === 'string' ? passthrough : undefined;
}

/**
 * Whether an error is Postgres aborting this transaction as a deadlock victim.
 *
 * Measured against a real database (#398, `apps/api-e2e/src/database/deadlock-shape.spec.ts`),
 * because a deadlock arrives in TWO shapes on this stack and the difference is the
 * whole reason it rendered as an untyped 500:
 *
 * - the losing statement was a model write → a bare `DriverAdapterError`, no Prisma
 *   class around it and no Prisma `code` at all;
 * - the losing statement was raw → `PrismaClientKnownRequestError` P2010, driver
 *   error tucked under `meta.driverAdapterError`.
 *
 * So this reads the SQLSTATE rather than the Prisma code, from either position. It
 * additionally accepts Prisma's own P2034 ("write conflict or a deadlock"), which
 * this stack does not currently emit — the shape pin records that — because the code
 * means, by definition, the thing a retry answers.
 *
 * Deliberately NOT a type predicate: the two shapes share no class, so narrowing to
 * one of them would be a lie about the other.
 */
export function isDeadlockError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  if (error['code'] === PrismaError.TransactionWriteConflict) {
    return true;
  }

  if (sqlStateOf(error['cause']) === DEADLOCK_SQLSTATE) {
    return true;
  }

  const meta = error['meta'];

  if (!isRecord(meta)) {
    return false;
  }

  const driverAdapterError = meta['driverAdapterError'];

  return isRecord(driverAdapterError) && sqlStateOf(driverAdapterError['cause']) === DEADLOCK_SQLSTATE;
}

/**
 * Run `operation`, and run it ONE more time if Postgres killed it as a deadlock
 * victim.
 *
 * Safe to replay because a deadlock aborts the victim's transaction WHOLE: nothing
 * is half-written, and a caller whose accumulators live inside the transaction has
 * nothing to unwind. That is the same argument `PluginUpdateService`'s P2002 retry
 * makes, and the same bound: once, not until-success. A second deadlock means a
 * contender is sustaining the contention, and answering that with a loop would hold
 * the claim open against it — so the error propagates, and the edge renders it as a
 * typed, retryable refusal rather than a bare 500.
 *
 * The operation must own its transaction. Wrapping a callback that runs INSIDE
 * someone else's transaction cannot work: the aborted transaction rejects every
 * subsequent statement, so the second attempt would fail on syntax it never
 * reached.
 */
export async function retryOnDeadlock<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isDeadlockError(error)) {
      throw error;
    }

    return await operation();
  }
}
