import { PrismaError } from '@status/codes';
import { Prisma } from '../client';

/**
 * TEST FIXTURES. Nothing in production should construct a Prisma error.
 *
 * Reachable only through `@bge/database/testing`, never the main barrel. That this
 * lives in a production library at all is a known wart with a known fix — see #305.
 *
 * Co-located with {@link constraintIdentity} deliberately: the defect these prevent
 * (#298, #210, #251) was possible because the FABRICATION and the READER lived in
 * different libraries, so four specs each invented their own payload and no single
 * place could be checked against a real database. The e2e pin in
 * `apps/api-e2e/src/database/p2002-shape.spec.ts` is what keeps this file honest.
 */

interface DriverAdapterCause {
  /**
   * The postgres passthrough fields, present when the adapter has no mapped
   * `kind` for the error — measured on a real 40P01 under 7.8 (#398), which 7.10
   * maps. Absent from the mapped shapes, which is why they are optional rather
   * than required.
   */
  readonly code?: string;

  readonly constraint?: { readonly fields?: readonly string[]; readonly index?: string };
  readonly detail?: string;
  readonly hint?: string;

  /** Where a mapped `DatabaseNotReachable` was trying to connect. */
  readonly host?: string;

  readonly kind: string;
  readonly message?: string;
  readonly originalCode?: string;

  /**
   * Postgres's own text. Absent from the socket-mapped kinds
   * (`DatabaseNotReachable`, `ConnectionClosed`), which no server answered (#1172).
   */
  readonly originalMessage?: string;

  readonly port?: number;
  readonly severity?: string;
}

/**
 * A real Error subclass rather than an object literal, because the descriptors are
 * load-bearing for anything that logs the payload: both `name` and `cause` are own
 * and enumerable, so `JSON.stringify(meta)` captures the constraint AND the class
 * name, while `message`/`stack` stay non-enumerable and drop out.
 *
 * `name` is declared as a CLASS FIELD, matching the real class verbatim —
 * `@prisma/driver-adapter-utils` writes `name = 'DriverAdapterError'` in the class
 * body (`dist/index.js:44` on 7.8.0), which makes it own, enumerable, writable, and
 * configurable. An earlier revision put it on the prototype as non-enumerable, on
 * the reasoning that `Error.prototype.name` is non-enumerable and `for...in` walks
 * inherited keys. True of `Error`, not true of this subclass: the field shadows the
 * prototype's, so a real payload yields `for...in` → `['name','cause']` and
 * `JSON.stringify` → `{"name":"DriverAdapterError",…}`. Reasoning from the base
 * class instead of measuring the real one is the same mistake #298 was about.
 *
 * Nothing in `constraintIdentity` reads this by enumeration — it is property access
 * throughout — so the divergence only ever showed up in the fidelity specs that
 * exist to catch exactly this.
 */
class DriverAdapterError extends Error {
  override readonly name = 'DriverAdapterError';
  override readonly cause: DriverAdapterCause;

  constructor(cause: DriverAdapterCause) {
    super(cause.kind);
    this.cause = cause;
  }
}

export interface UniqueViolationOptions {
  /** Name quoted into `cause.originalMessage`, as Postgres phrases it. */
  readonly constraintName?: string;

  /**
   * Raw DB column names under `cause.constraint.fields`, which
   * `@prisma/adapter-pg` reported up to 7.8 and reports since 7.10 only when
   * Postgres names no constraint.
   */
  readonly fields?: readonly string[];

  /**
   * The constraint name under `cause.constraint.index`, which
   * `@prisma/adapter-pg@7.10` reports. This is the shape that actually ships.
   */
  readonly index?: string;

  /** Prisma's own `meta.modelName`. Nothing should read it — see #302. */
  readonly modelName?: string;

  /**
   * Omit `driverAdapterError` entirely, leaving `meta` with only `modelName`.
   * Models a Prisma release that stops exposing the adapter error.
   */
  readonly omitDriverAdapterError?: boolean;

  /**
   * Omit `meta` entirely. This is what a P2002 looked like to the four specs that
   * never fabricated one correctly, and it must map to each caller's documented
   * `unknown` fallback.
   */
  readonly omitMeta?: boolean;

  /** SQLSTATE. `23505` is unique_violation. */
  readonly sqlState?: string;

  /**
   * Legacy `meta.target`. Absent on `@prisma/client@7.8.0` through 7.10 with
   * `@prisma/adapter-pg` (prisma/prisma#28953); supply it only to exercise the
   * restored-`target` path.
   */
  readonly target?: string | readonly string[];
}

/**
 * A P2002 in the shape `@prisma/client` + `@prisma/adapter-pg` on Postgres 17
 * actually raises: `index` for 7.10, `fields` for 7.8 (measured 2026-08-10, #298).
 *
 * Defaults to a well-formed driver-adapter payload so a spec must opt IN to
 * degradation. The old helper defaulted to a fabricated `meta.target`, which is why
 * twelve green tests never touched reality.
 */
export function uniqueViolation(options: UniqueViolationOptions = {}): Prisma.PrismaClientKnownRequestError {
  const {
    fields,
    index,
    target,
    modelName = 'TestModel',
    constraintName = 'test_unique_constraint',
    sqlState = '23505',
    omitDriverAdapterError = false,
    omitMeta = false,
  } = options;

  const meta: Record<string, unknown> = { modelName };

  if (target !== undefined) {
    meta['target'] = target;
  }

  // A default `fields` is synthesized only when the caller names NO source at all.
  // Supplying `target` alone means target-ONLY: `constraintIdentity` prefers the
  // driver payload, so a synthesized default would shadow the field the caller
  // asked to exercise and the case would quietly assert something else.
  const explicitConstraint = fields !== undefined ? { fields } : index !== undefined ? { index } : undefined;
  const constraint = explicitConstraint ?? (target === undefined ? { fields: ['test_column'] } : undefined);

  if (!omitDriverAdapterError && constraint !== undefined) {
    meta['driverAdapterError'] = new DriverAdapterError({
      originalCode: sqlState,
      originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
      kind: 'UniqueConstraintViolation',
      constraint,
    });
  }

  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: PrismaError.UniqueConstraintViolation,
    clientVersion: 'test',
    ...(omitMeta ? {} : { meta }),
  });
}

/**
 * A P2002 with no `meta` at all — the shape every pre-#298 spec fabricated by
 * omission, and the one the row-lookup recovery paths (#210, #251) must replay on.
 */
export function uniqueViolationWithoutMeta(): Prisma.PrismaClientKnownRequestError {
  return uniqueViolation({ omitMeta: true });
}

export interface DeadlockOptions {
  /**
   * Drop `cause.originalCode`. On the `bare` shape that leaves only the
   * postgres-passthrough `code`, modelling a driver release that renames the
   * field the reader prefers.
   */
  readonly omitOriginalCode?: boolean;

  /**
   * Which statement lost, which decides the class around the driver error:
   *
   * - `model-write` (the default): an ordinary model write. Since
   *   `@prisma/adapter-pg@7.10` the adapter maps 40P01 to
   *   `TransactionWriteConflict` and the client wraps it as P2034, driver error
   *   under `meta.driverAdapterError`.
   * - `raw`: `$queryRaw`/`$executeRaw`. Wrapped as P2010 whatever the kind,
   *   driver error under `meta.driverAdapterError`.
   * - `bare`: the model-write shape up to 7.8, which #398's production case
   *   produced. The adapter had no mapped kind for 40P01 and passed it through as
   *   `kind: 'postgres'` with the raw pg fields alongside, so the driver error
   *   escaped with no Prisma class around it and no Prisma `code` at all.
   */
  readonly shape?: 'model-write' | 'raw' | 'bare';

  /** SQLSTATE on the driver error. `40P01` is deadlock_detected. */
  readonly sqlState?: string;
}

/**
 * A deadlock in the shape `@prisma/client@7.10` + `@prisma/adapter-pg@7.10` on
 * Postgres 17 raises, pinned by `apps/api-e2e/src/database/deadlock-shape.spec.ts`.
 * First measured against 7.8.0 on 2026-08-27 (#398); `shape: 'bare'` keeps that
 * version's model-write shape, which `isDeadlockError` still classifies.
 *
 * The shapes differ in class and in Prisma `code`, which is why a predicate
 * testing only `instanceof PrismaClientKnownRequestError`, or only one code, is
 * blind to one of them.
 */
export function deadlock(options: DeadlockOptions = {}): Error {
  const { shape = 'model-write', sqlState = '40P01', omitOriginalCode = false } = options;
  const originalCode = omitOriginalCode ? {} : { originalCode: sqlState };

  if (shape === 'bare') {
    return new DriverAdapterError({
      ...originalCode,
      originalMessage: 'deadlock detected',
      kind: 'postgres',
      code: sqlState,
      severity: 'ERROR',
      message: 'deadlock detected',
      detail:
        'Process 596 waits for ShareLock on transaction 2646; blocked by process 594.\n' +
        'Process 594 waits for ShareLock on transaction 2647; blocked by process 596.',
      hint: 'See server log for query details.',
    });
  }

  const driverError = new DriverAdapterError({
    ...originalCode,
    originalMessage: 'deadlock detected',
    kind: 'TransactionWriteConflict',
  });

  if (shape === 'raw') {
    return new Prisma.PrismaClientKnownRequestError(
      '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `40P01`. Message: `deadlock detected`',
      {
        code: PrismaError.RawQueryFailed,
        clientVersion: 'test',
        meta: { driverAdapterError: driverError },
      },
    );
  }

  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    {
      code: PrismaError.TransactionWriteConflict,
      clientVersion: 'test',
      meta: { driverAdapterError: driverError },
    },
  );
}

/**
 * Prisma's OWN spelling for a deadlock — P2034, documented as "write conflict or
 * deadlock" — with nothing under `meta`. The predicate accepts the code alone:
 * it means, by definition, the thing a client's retry answers.
 */
export function transactionWriteConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    { code: PrismaError.TransactionWriteConflict, clientVersion: 'test' },
  );
}

/**
 * The database server refused the connection, or its host name did not
 * resolve: P1001 with a mapped `DatabaseNotReachable` cause. The shape
 * `@prisma/adapter-pg@7.10` raises for a host with a single address, pinned by
 * `apps/api-e2e/src/database/database-unavailable-shape.spec.ts` (#1172).
 */
export function databaseUnreachable(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Can't reach database server at db.example.test:5432", {
    code: PrismaError.DatabaseUnreachable,
    clientVersion: 'test',
    meta: {
      modelName: 'User',
      driverAdapterError: new DriverAdapterError({ kind: 'DatabaseNotReachable', host: 'db.example.test', port: 5432 }),
    },
  });
}

/**
 * Every address of a host name refused the connection. Node's connect raises
 * an `AggregateError` with no `syscall`, which the adapter doesn't recognise as
 * a socket error and rethrows raw, so Prisma wraps it under Node's own code,
 * `ECONNREFUSED`, with no driver error under `meta` (#1172). `localhost` reaches
 * this shape where it resolves to both `::1` and `127.0.0.1`.
 */
export function connectionRefusedAtEveryAddress(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('', {
    code: 'ECONNREFUSED',
    clientVersion: 'test',
    meta: { modelName: 'User' },
  });
}

/**
 * A socket error the adapter never maps, rethrown raw and wrapped by Prisma
 * under Node's own code with no driver error under `meta`: `EHOSTUNREACH` for
 * a host with no route, `EAI_AGAIN` for a resolver that's down (#1172).
 */
export function unmappedSocketError(code = 'EHOSTUNREACH'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`connect ${code} 10.0.0.9:5432`, {
    code,
    clientVersion: 'test',
    meta: { modelName: 'User' },
  });
}

/**
 * An interactive transaction that couldn't get a connection within `maxWait`,
 * as against a server that accepts the connection and never answers: P2028
 * with an empty `meta` (#1172).
 */
export function transactionStartTimedOut(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction API error: Unable to start a transaction in the given time.',
    { code: 'P2028', clientVersion: 'test', meta: {} },
  );
}

/**
 * A statement on an interactive transaction that outlived its `timeout`:
 * P2028 too, but the code's own slowness rather than an outage (#1172).
 */
export function transactionExpired(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 100 ms, however 302 ms passed since the start of the transaction.',
    { code: 'P2028', clientVersion: 'test', meta: { operation: 'query', timeout: 100, timeTaken: 302 } },
  );
}

/**
 * The server closed the connection before answering: P1017 with a mapped
 * `ConnectionClosed` cause (#1172).
 */
export function serverClosedConnection(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
    code: PrismaError.ServerClosedConnection,
    clientVersion: 'test',
    meta: { modelName: 'User', driverAdapterError: new DriverAdapterError({ kind: 'ConnectionClosed' }) },
  });
}

export interface AdminShutdownOptions {
  /**
   * Which statement the backend was serving when it ended. A model statement
   * gets Prisma's generic database error, P2039; a raw one gets P2010. Either
   * way the SQLSTATE sits under `meta.driverAdapterError`.
   */
  readonly statement?: 'model' | 'raw';
}

/**
 * Postgres ended the backend mid-statement, `pg_terminate_backend` or a fast
 * shutdown: SQLSTATE 57P01 with severity FATAL, which the adapter passes
 * through as `kind: 'postgres'` (#1172).
 */
export function adminShutdown(options: AdminShutdownOptions = {}): Prisma.PrismaClientKnownRequestError {
  const { statement = 'model' } = options;
  const message = 'terminating connection due to administrator command';
  const driverAdapterError = new DriverAdapterError({
    originalCode: '57P01',
    originalMessage: message,
    kind: 'postgres',
    code: '57P01',
    severity: 'FATAL',
    message,
  });

  return statement === 'raw'
    ? new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`57P01\`. Message: \`${message}\``, {
        code: PrismaError.RawQueryFailed,
        clientVersion: 'test',
        meta: { driverAdapterError },
      })
    : new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`57P01\`. Message: \`${message}\``, {
        code: 'P2039',
        clientVersion: 'test',
        meta: { modelName: 'User', driverAdapterError },
      });
}

/**
 * The client could not be initialised: a fault of the build or the setup, such
 * as an adapter for another provider. With a driver adapter it never means the
 * database is down, which arrives as a request error instead (#1172).
 */
export function clientInitializationFailed(): Prisma.PrismaClientInitializationError {
  return new Prisma.PrismaClientInitializationError(
    'The Driver Adapter `@prisma/adapter-pg`, based on `postgres`, is not compatible with the provider `mysql` specified in the Prisma schema.',
    'test',
  );
}

/**
 * node-postgres's own codeless errors, which the adapter rethrows raw and
 * Prisma passes on as a plain `Error` with its `clientVersion` attached (#1172).
 */
function codelessDriverError(message: string): Error {
  return Object.assign(new Error(message), { clientVersion: 'test' });
}

/** The connection dropped while a statement was running (#1172). */
export function connectionTerminated(): Error {
  return codelessDriverError('Connection terminated unexpectedly');
}

/**
 * The next statement on a connection that has already failed, such as a
 * transaction whose backend was ended while it waited (#1172).
 */
export function connectionNotQueryable(): Error {
  return codelessDriverError('Client has encountered a connection error and is not queryable');
}
