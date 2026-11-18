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
 * preferred. `code` is the postgres passthrough copy, present when the adapter has
 * no mapped `kind` for an error and forwards the raw pg fields alongside — a
 * deadlock was one of those up to `@prisma/adapter-pg@7.8`. Reading both means a
 * driver release that keeps only one of them still classifies. The catalog entry
 * check reads it too, to tell a value Postgres refused from a database that
 * failed (#772).
 */
export function sqlStateOf(cause: unknown): string | undefined {
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
 * because a deadlock arrives in more than one shape and the difference is the whole
 * reason it once rendered as an untyped 500. On `@prisma/adapter-pg@7.10`:
 *
 * - the losing statement was a model write → `PrismaClientKnownRequestError`
 *   P2034 ("write conflict or a deadlock"), driver error under
 *   `meta.driverAdapterError`;
 * - the losing statement was raw → `PrismaClientKnownRequestError` P2010, driver
 *   error under `meta.driverAdapterError`.
 *
 * Up to 7.8 the model-write case was a bare `DriverAdapterError` with no Prisma
 * class around it and no Prisma `code` at all — the #398 shape.
 *
 * So this accepts P2034, which means by definition the thing a client's retry
 * answers, and otherwise reads the SQLSTATE rather than the Prisma code, from the
 * bare position as well as under `meta`, so a regression to the old shape still
 * classifies.
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
