import { PG, PrismaError } from '@status/codes';
import { Prisma } from '../client';
import { sqlStateOf } from './deadlock';

/** Prisma's own codes for a database it couldn't reach or keep talking to (#1172). */
const UNAVAILABLE_PRISMA_CODES: ReadonlySet<string> = new Set([
  PrismaError.DatabaseUnreachable,
  PrismaError.OperationTimeout,
  PrismaError.ServerClosedConnection,
  PrismaError.TooManyDatabaseConnections,
]);

/**
 * Node's error codes for a connect that failed or a socket that dropped. The
 * adapter maps four of them itself (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`,
 * `ETIMEDOUT`), but only when they arrive with a `syscall`. It rethrows any
 * other code raw, and those four too inside the `AggregateError` a connect
 * raises when it fails at every address of a host name. Prisma then wraps the
 * error under Node's own code. A host with no route (`EHOSTUNREACH`, a NAS
 * switched off) and a resolver that's down (`EAI_AGAIN`) arrive that way. Read
 * only off a Prisma error: Redis's client raises the same codes, and its
 * outage is `AUTH_UNAVAILABLE`'s, not this (#1172).
 */
const UNMAPPED_SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
]);

/**
 * The text of P2028's start-timeout variant. P2028 covers every failure of
 * the interactive transaction API, and the rest (a transaction that expired,
 * was already closed or isn't known) are the code's own slowness or misuse.
 * This one says no connection came within `maxWait`: a database that hangs
 * instead of refusing (the pool has no connect timeout, #447), or a pool every
 * request already holds. Either way, trying again later may work. Prisma
 * raises it with an empty `meta`, so its text is all that tells it apart
 * (#1172).
 */
const TRANSACTION_START_TIMEOUT = 'Unable to start a transaction in the given time.';

/** SQLSTATEs that say the server can't serve this connection, whatever the statement. */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set([
  PG.TooManyConnections,
  PG.AdminShutdown,
  PG.CrashShutdown,
  PG.CannotConnectNow,
]);

/** SQLSTATE class 08, connection exception. */
const CONNECTION_EXCEPTION_CLASS = '08';

/**
 * node-postgres's codeless connection errors, matched by exact text because
 * they carry nothing else. Only the ones the shape spec observed (#1172).
 */
const CODELESS_DRIVER_MESSAGES: ReadonlySet<string> = new Set([
  // The socket closed before the server answered, or while a statement ran.
  'Connection terminated unexpectedly',
  // A statement on a client whose connection already failed.
  'Client has encountered a connection error and is not queryable',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A driver adapter's `cause`: bare on a `DriverAdapterError` thrown with no
 * Prisma class around it (the #398 shape), or under `meta.driverAdapterError`.
 * The bare one counts only when it names a `kind`, as every adapter cause
 * does, so another library's error whose `cause` carries a `code` isn't read
 * as a SQLSTATE (#1172).
 */
function driverCauseOf(error: Record<string, unknown>): Record<string, unknown> | undefined {
  const bare = error['cause'];

  if (isRecord(bare) && typeof bare['kind'] === 'string') {
    return bare;
  }

  const meta = error['meta'];
  const driverAdapterError = isRecord(meta) ? meta['driverAdapterError'] : undefined;
  const cause = isRecord(driverAdapterError) ? driverAdapterError['cause'] : undefined;

  return isRecord(cause) ? cause : undefined;
}

/**
 * Whether an error means the database couldn't be reached, or dropped the
 * connection, rather than refusing this one statement (#1172). The edges
 * answer it 503 `DATABASE_UNAVAILABLE` instead of an uncoded 500.
 *
 * Measured against a real database on `@prisma/client@7.10.1`,
 * `@prisma/adapter-pg@7.10.1`, `pg@8.23.1` and Postgres 17
 * (`apps/api-e2e/src/database/database-unavailable-shape.spec.ts`), because an
 * outage arrives in more than one shape:
 *
 * - connection refused at a host's only address, or its name doesn't resolve
 *   → P1001; the server reset the connection before answering → P1017;
 * - connection refused at every address of a host (`localhost` on a machine
 *   that resolves it to `::1` and `127.0.0.1`) → a Prisma error whose `code` is
 *   Node's `ECONNREFUSED`, nothing under `meta`, and an empty message;
 * - a host with no route, or a resolver that's down → a Prisma error whose
 *   `code` is Node's (`EHOSTUNREACH`, `EAI_AGAIN`), nothing under `meta`;
 * - a server that accepts the connection and never answers → P2028 for an
 *   interactive transaction, once `maxWait` passes;
 * - the backend ended mid-statement (`pg_terminate_backend`, a fast shutdown)
 *   → P2039 for a model statement, P2010 for a raw one, SQLSTATE 57P01 under
 *   `meta.driverAdapterError`;
 * - the server closed the connection cleanly before answering, the socket
 *   dropped mid-statement, or the next statement on a connection that already
 *   failed → a plain `Error` with node-postgres's own text and no code.
 *
 * The rest (P1008, P2037, 53300, 57P02, 57P03, class 08) are what the adapter
 * maps or passes through for a timeout, a full server, a crash or a server
 * still starting, read from its source rather than observed.
 *
 * A deadlock is not an outage: the database is up, and the deadlock keeps its
 * 409. Neither is a fault only the operator can clear, wrong credentials
 * (P1000) or a missing database (P1003): those keep the 500. Nor is a
 * `PrismaClientInitializationError`. With a driver adapter the client connects
 * on its first query, and `$connect()` resolves with the database down, so an
 * unreachable server arrives as a request error (P1001 above). What's left to
 * fail at initialisation is the build or the setup: a missing query compiler,
 * no adapter, or an adapter for another provider. Message text is
 * never read, apart from node-postgres's codeless errors matched exactly and
 * P2028's start timeout.
 *
 * Deliberately NOT a type predicate, as with `isDeadlockError`: the shapes
 * share no class.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  if (error instanceof Error && CODELESS_DRIVER_MESSAGES.has(error.message)) {
    return true;
  }

  if (!isRecord(error)) {
    return false;
  }

  const code = error['code'];

  if (typeof code === 'string' && UNAVAILABLE_PRISMA_CODES.has(code)) {
    return true;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (UNMAPPED_SOCKET_CODES.has(error.code)) {
      return true;
    }

    if (error.code === PrismaError.TransactionApiError && error.message.endsWith(TRANSACTION_START_TIMEOUT)) {
      return true;
    }
  }

  const sqlState = sqlStateOf(driverCauseOf(error));

  return (
    sqlState !== undefined && (UNAVAILABLE_SQLSTATES.has(sqlState) || sqlState.startsWith(CONNECTION_EXCEPTION_CLASS))
  );
}

/**
 * What tells one database failure from another in a log line: the error's
 * code, and the driver's `kind` and SQLSTATE when it carries them. An outage's
 * message can be empty (a connect refused at every address of a host) and its
 * stack names only the class, so without this the log can't say whether the
 * server refused, didn't resolve or ended the backend (#1172).
 */
export function describeDatabaseError(error: unknown): string {
  if (!isRecord(error)) {
    return 'no code';
  }

  const parts: string[] = [];
  const code = error['code'];

  if (typeof code === 'string') {
    parts.push(`code=${code}`);
  }

  const cause = driverCauseOf(error);
  const kind = cause?.['kind'];
  const sqlState = sqlStateOf(cause);

  if (typeof kind === 'string') {
    parts.push(`kind=${kind}`);
  }

  if (sqlState !== undefined) {
    parts.push(`sqlstate=${sqlState}`);
  }

  return parts.length > 0 ? parts.join(' ') : 'no code';
}
