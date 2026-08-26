import { setTimeout as sleep } from 'node:timers/promises';
import { Client, type QueryResultRow } from 'pg';
import { schemaFromDatabaseUrl } from './e2e-env';

/**
 * Lock barriers against the harness's Postgres: two contending transactions,
 * watched from a third connection (#239).
 *
 * The suite is black-box everywhere else: specs assert application behavior
 * over HTTP. This module is the deliberate exception, and it is narrow. Some
 * facts about a raw `FOR UPDATE` / `FOR SHARE` statement are not observable
 * from outside the process at all — whether it BLOCKS a second transaction is
 * the whole justification for writing it that way, and an HTTP race can only
 * ever show that the invariant held on the interleavings it happened to hit.
 *
 * So: HTTP races pin the product invariant, and these barriers pin the
 * mechanism. Neither substitutes for the other, and #239 carries both.
 *
 * Three connections, because proving "blocked" needs a witness:
 *
 *  - `holder` takes the lock and keeps its transaction open.
 *  - `waiter` issues the contending statement, which is expected to block.
 *  - `observer` reads `pg_locks` — a blocked backend cannot answer for itself,
 *    and in the deadlock cases BOTH contenders are blocked at once.
 *
 * D-239-1: these live here rather than in `@bge/testing-e2e` until a second
 * consumer shapes the API (#383, tracked for promotion by #384).
 */

/**
 * How long a blocked statement waits before Postgres cancels it. Must exceed
 * {@link DEFAULT_BLOCKED_TIMEOUT_MS} by enough that an assertion of "blocked"
 * finishes first — otherwise a correct block is reported as a lock timeout.
 */
export const BARRIER_LOCK_TIMEOUT_MS = 10_000;

/** Backstop for a statement that is not waiting on a lock but is not finishing. */
export const BARRIER_STATEMENT_TIMEOUT_MS = 20_000;

/**
 * D-239-3, the load-bearing one. A barrier connection abandoned mid-transaction
 * by a failed assertion holds its locks, and the between-test sweep's TRUNCATE
 * needs ACCESS EXCLUSIVE — so the leak does not fail the test that caused it,
 * it hangs the NEXT test until Jest's 120s timeout and reports there. Every
 * barrier is closed in a `finally`; this is the belt to that pair of braces.
 */
export const BARRIER_IDLE_IN_TRANSACTION_TIMEOUT_MS = 20_000;

/** How long {@link expectBlocked} waits to witness the block. */
export const DEFAULT_BLOCKED_TIMEOUT_MS = 3_000;

/** How long {@link expectNotBlocked} allows a statement that must not wait. */
export const DEFAULT_UNBLOCKED_TIMEOUT_MS = 3_000;

const POLL_INTERVAL_MS = 25;

/** Postgres identifiers this module is willing to interpolate. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One row of `pg_locks` for a backend that is waiting. */
export interface UngrantedLock {
  readonly locktype: string;
  readonly mode: string;
  readonly relation: string | null;
}

export interface BarrierTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
}

/**
 * A statement issued but deliberately not awaited — the thing whose blocking
 * is under test. The underlying promise is settled-tracked and pre-handled, so
 * a rejection (a lock timeout, say) does not surface as an unhandled rejection
 * while the spec is still deciding what to assert about it.
 */
export interface PendingStatement<TRow extends QueryResultRow = QueryResultRow> {
  readonly description: string;

  /**
   * The backend that issued it — the one whose wait is under test.
   *
   * Carried on the statement rather than looked up on `barrier.waiter`, because
   * the holder can issue a pending statement too: the deadlock case (#383) has
   * both sides waiting at once. Judging a holder-issued statement against the
   * waiter's backend passes while the holder never blocked at all, which is the
   * single outcome these assertions exist to rule out.
   */
  readonly pid: number;

  /** True once the statement has completed OR failed. */
  settled(): boolean;

  /** The rows, or a rejection carrying whatever Postgres said. */
  result(): Promise<TRow[]>;

  /** The failure, if it has already failed. For diagnostics only. */
  failure(): unknown;
}

export interface BarrierConnection {
  /** Appears in failure messages — `holder`, `waiter`, `observer`. */
  readonly label: string;

  /** This connection's backend pid, as `pg_locks` reports it. */
  readonly pid: number;

  query<TRow extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<TRow[]>;

  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;

  /** Issues a statement WITHOUT awaiting it. See {@link PendingStatement}. */
  issue<TRow extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
    description?: string,
  ): PendingStatement<TRow>;

  close(): Promise<void>;
}

export interface Barrier {
  readonly holder: BarrierConnection;
  readonly waiter: BarrierConnection;
  readonly observer: BarrierConnection;
}

/** Quotes an identifier, or refuses. `search_path` cannot be parameterized. */
export function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to interpolate unsafe identifier '${name}' into a barrier session setting`);
  }

  return `"${name}"`;
}

/**
 * The session state every barrier connection opens with: the harness's schema,
 * and a bound on every way a connection can wait.
 */
export function barrierSessionSettings(schema: string, overrides: Partial<BarrierTimeouts> = {}): readonly string[] {
  const lockTimeoutMs = overrides.lockTimeoutMs ?? BARRIER_LOCK_TIMEOUT_MS;
  const statementTimeoutMs = overrides.statementTimeoutMs ?? BARRIER_STATEMENT_TIMEOUT_MS;
  const idleInTransactionTimeoutMs = overrides.idleInTransactionTimeoutMs ?? BARRIER_IDLE_IN_TRANSACTION_TIMEOUT_MS;

  return [
    `SET search_path TO ${quoteIdentifier(schema)}`,
    `SET lock_timeout TO ${lockTimeoutMs}`,
    `SET statement_timeout TO ${statementTimeoutMs}`,
    `SET idle_in_transaction_session_timeout TO ${idleInTransactionTimeoutMs}`,
  ];
}

/** Renders ungranted locks for a failure message. */
export function describeUngrantedLocks(locks: readonly UngrantedLock[]): string {
  if (locks.length === 0) {
    return 'no ungranted locks';
  }

  return locks
    .map((lock) => `${lock.locktype}/${lock.mode}${lock.relation === null ? '' : ` on ${lock.relation}`}`)
    .join(', ');
}

/**
 * Opens a barrier connection against the harness's database.
 *
 * A `pg.Client`, not the `Pool` `test-db` uses: a barrier needs ONE backend
 * whose transaction state and pid stay put across statements, and a pool is
 * free to hand back a different connection per query.
 */
export async function openBarrierConnection(
  label: string,
  options: { readonly databaseUrl?: string; readonly timeouts?: Partial<BarrierTimeouts> } = {},
): Promise<BarrierConnection> {
  const databaseUrl = options.databaseUrl ?? process.env['DATABASE_URL'];

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — did the e2e globalSetup run?');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    for (const setting of barrierSessionSettings(schemaFromDatabaseUrl(databaseUrl), options.timeouts)) {
      await client.query(setting);
    }

    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]?.pid;

    if (typeof pid !== 'number') {
      throw new Error(`Could not read the backend pid for barrier connection '${label}'`);
    }

    return buildConnection(label, pid, client);
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

/**
 * Opens the holder/waiter/observer trio, runs the scenario, and closes all
 * three whatever happens (D-239-3).
 *
 * Rollback before close is deliberate: `end()` alone leaves the server to
 * notice the disconnect, and the window between "test failed" and "backend
 * reaped" is exactly the window the next test's TRUNCATE waits in.
 */
export async function withBarrier<T>(run: (barrier: Barrier) => Promise<T>): Promise<T> {
  const connections: BarrierConnection[] = [];

  try {
    for (const label of ['holder', 'waiter', 'observer'] as const) {
      connections.push(await openBarrierConnection(label));
    }

    const [holder, waiter, observer] = connections as [BarrierConnection, BarrierConnection, BarrierConnection];

    return await run({ holder, waiter, observer });
  } finally {
    for (const connection of connections) {
      await connection.rollback().catch(() => undefined);
      await connection.close().catch(() => undefined);
    }
  }
}

/**
 * Asserts that `pending` is WAITING on a lock — not merely slow.
 *
 * D-239-2. The cheap version of this assertion is "it has not finished yet",
 * which is a statement about how busy the machine is; on a loaded CI runner it
 * passes for a statement that is not blocked at all, and it is the construct
 * that turns into flake. So the assertion is positive: the waiter's backend
 * holds an ungranted lock, read from a third connection because a blocked
 * backend cannot answer for itself.
 */
export async function expectBlocked(
  barrier: Barrier,
  pending: PendingStatement,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (pending.settled()) {
      throw new Error(
        `${pending.description} completed instead of blocking. The lock it contends for is not being held, ` +
          `or is being held in a mode that does not conflict — which is the defect this barrier exists to catch. ` +
          `${describeSettled(pending)}`,
      );
    }

    const locks = await ungrantedLocks(barrier.observer, pending.pid);

    if (locks.length > 0) {
      return;
    }

    if (Date.now() >= deadline) {
      const activity = await backendActivity(barrier.observer, pending.pid);

      throw new Error(
        `${pending.description} never blocked: after ${timeoutMs}ms its backend (pid ${pending.pid}) held ` +
          `no ungranted lock. Backend state: ${activity}. Either the other transaction's statement does not ` +
          `take a conflicting lock, or this one does not contend for it.`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Asserts that `pending` completes WITHOUT waiting.
 *
 * The control case, and it is not decoration. `FOR SHARE` is only the right
 * lock mode because the weaker `FOR KEY SHARE` — which the foreign key already
 * takes implicitly — does NOT conflict with the soft-delete's non-key UPDATE.
 * A suite that only ever shows things blocking cannot tell a correct lock from
 * one that is simply too strong.
 */
export async function expectNotBlocked(
  barrier: Barrier,
  pending: PendingStatement,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNBLOCKED_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (pending.settled()) {
      // Surfaces a rejection (a lock timeout, a SQL error) as a failure here
      // rather than letting the spec read it as success.
      await pending.result();
      return;
    }

    if (Date.now() >= deadline) {
      const locks = await ungrantedLocks(barrier.observer, pending.pid);

      throw new Error(
        `${pending.description} was expected to proceed, but had not completed after ${timeoutMs}ms ` +
          `(pid ${pending.pid}: ${describeUngrantedLocks(locks)}). A lock mode that blocks here ` +
          `is stronger than the invariant needs.`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * A backend waiting on an advisory lock the holder is holding — and what it is
 * running while it waits.
 *
 * The pid-keyed assertions above cannot reach an application transaction: the
 * API's request runs on a connection from its own pool, and a spec that never
 * imports application code has no way to learn which backend that is. So the
 * question is turned around. Rather than "is this pid blocked", ask "is anyone
 * blocked on the key I am holding", which is answerable from `pg_locks` alone
 * and is the same fact from the other side.
 *
 * Three predicates keep that from meaning "anyone, anywhere, is waiting":
 *
 *  - the join against the holder's own GRANTED rows narrows it to this key;
 *  - `database` is compared because advisory locks are per-database while
 *    `pg_locks` is cluster-wide, so the same key in another database on a
 *    shared server would otherwise join;
 *  - `exclude` lets the caller rule out the barrier's own connections, without
 *    which a spec that contends holder against waiter would report the waiter
 *    and read as though the application had queued.
 *
 * Ordered by pid so a scenario with more than one contender returns the same
 * one every run rather than whichever row Postgres happened to emit first.
 */
export interface AdvisoryWaiter {
  readonly pid: number;

  /** The statement the waiting backend is running, per `pg_stat_activity`. */
  readonly query: string;
}

export async function advisoryWaiters(
  observer: BarrierConnection,
  heldBy: number,
  exclude: readonly number[] = [],
): Promise<AdvisoryWaiter[]> {
  return observer.query<AdvisoryWaiter>(
    `SELECT DISTINCT waiting.pid, coalesce(activity.query, '') AS query
     FROM pg_locks waiting
     JOIN pg_locks held
       ON held.locktype = 'advisory'
      AND held.granted
      AND held.classid = waiting.classid
      AND held.objid = waiting.objid
      AND held.objsubid = waiting.objsubid
      AND held.database = waiting.database
     LEFT JOIN pg_stat_activity activity ON activity.pid = waiting.pid
     WHERE waiting.locktype = 'advisory'
       AND NOT waiting.granted
       AND held.pid = $1
       AND waiting.pid <> ALL($2::int[])
     ORDER BY waiting.pid`,
    [heldBy, [heldBy, ...exclude]],
  );
}

/**
 * Asserts that some other backend is waiting on the advisory lock `heldBy`
 * holds, and returns it.
 *
 * The positive form of "the request has not come back yet", which on a loaded
 * machine is a statement about the machine. Same discipline {@link expectBlocked}
 * applies (#239), reached the only way it can be when the blocked party is the
 * application rather than a barrier connection.
 *
 * `settledEarly` is how a fixture problem stops looking like a lock problem. A
 * request refused by an authorization gate never reaches the lock, and from
 * `pg_locks` that is indistinguishable from one that took a different key — so
 * the caller passes a probe for its own request, and a request that answered is
 * reported as answered instead of timing out with three guesses.
 */
export async function expectAdvisoryWaiter(
  barrier: Barrier,
  options: {
    readonly heldBy: number;
    readonly description: string;
    readonly timeoutMs?: number;
    readonly exclude?: readonly number[];
    readonly settledEarly?: () => string | undefined;
  },
): Promise<AdvisoryWaiter> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const waiters = await advisoryWaiters(barrier.observer, options.heldBy, options.exclude);
    const waiter = waiters[0];

    if (waiter !== undefined) {
      return waiter;
    }

    const settled = options.settledEarly?.();

    if (settled !== undefined) {
      throw new Error(
        `${options.description} answered without ever queueing behind the advisory key held by pid ` +
          `${options.heldBy}: ${settled}. Most likely something in front of the lock refused it — an ` +
          `authorization gate, a missing fixture, a rejected body — so this case raced nothing. A 5xx here ` +
          `means the opposite: it reached the lock and its own transaction budget ran out while waiting.`,
      );
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${options.description} never waited on the advisory key held by pid ${options.heldBy}: after ` +
          `${timeoutMs}ms no other backend held an ungranted lock on it, and it had not answered either. ` +
          `Either it takes a different key, or it is still working its way toward the lock — which on a cold ` +
          `run can take longer than this budget.`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/** The ungranted locks a backend is waiting on, if any. */
export async function ungrantedLocks(observer: BarrierConnection, pid: number): Promise<UngrantedLock[]> {
  return observer.query<UngrantedLock>(
    `SELECT locktype, mode, relation::regclass::text AS relation
     FROM pg_locks
     WHERE pid = $1 AND NOT granted`,
    [pid],
  );
}

async function backendActivity(observer: BarrierConnection, pid: number): Promise<string> {
  const rows = await observer.query<{
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
  }>(`SELECT state, wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`, [pid]);

  const row = rows[0];

  if (!row) {
    return `no pg_stat_activity row for pid ${pid} (the connection is gone)`;
  }

  return `state=${row.state ?? 'null'} wait=${row.wait_event_type ?? 'none'}/${row.wait_event ?? 'none'}`;
}

function describeSettled(pending: PendingStatement): string {
  const failure = pending.failure();

  if (failure === undefined) {
    return 'It returned successfully.';
  }

  return `It failed with: ${failure instanceof Error ? failure.message : String(failure)}`;
}

function buildConnection(label: string, pid: number, client: Client): BarrierConnection {
  const query = async <TRow extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<TRow[]> => {
    const result = await client.query<TRow>(sql, [...params]);

    return result.rows;
  };

  return {
    label,
    pid,
    query,
    begin: () => query('BEGIN').then(() => undefined),
    commit: () => query('COMMIT').then(() => undefined),
    rollback: () => query('ROLLBACK').then(() => undefined),

    issue: <TRow extends QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
      description = `${label}: ${firstLine(sql)}`,
    ): PendingStatement<TRow> => {
      let settled = false;
      let failure: unknown;

      const promise = client.query<TRow>(sql, [...params]).then(
        (result) => {
          settled = true;
          return result.rows;
        },
        (error: unknown) => {
          settled = true;
          failure = error;
          throw error;
        },
      );

      // The statement is deliberately not awaited yet, and an unhandled
      // rejection would take the worker down before the spec can assert on it.
      promise.catch(() => undefined);

      return {
        description,
        pid,
        settled: () => settled,
        result: () => promise,
        failure: () => failure,
      };
    },

    close: () => client.end(),
  };
}

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0]?.trim() ?? sql;
}
