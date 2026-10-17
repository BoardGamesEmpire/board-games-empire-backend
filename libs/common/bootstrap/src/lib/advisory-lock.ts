import { PG } from '@status/codes';
import { Client } from 'pg';
import type { BootstrapLock, BootstrapLogger, Clock, LockAcquireOptions } from './ports';
import { DEFAULT_WAIT_MS, systemClock } from './ports';

/**
 * The lock's name; the bigint key is `hashtextextended(name, 0)`, computed by
 * Postgres so it cannot collide with Prisma Migrate's own advisory key and so
 * a test can compute exactly the same value.
 */
export const BOOTSTRAP_LOCK_NAME = 'bge:bootstrap';

/** How long one blocking attempt waits before the progress log names the holder. */
export const LOCK_ATTEMPT_MS = 5_000;

/**
 * How much longer than its `lock_timeout` an attempt may go unanswered before
 * it is abandoned with its connection, and how long a read of the holder or the
 * COMMIT that releases the lock may. `lock_timeout` runs in Postgres, so it
 * cannot bound a wait to reach Postgres: a connection pooler queues an attempt
 * until a server connection is free.
 */
export const LOCK_ATTEMPT_GRACE_MS = 1_000;

/**
 * How long the lock's connection sits idle before TCP probes it. Below the
 * idle timeouts of common load balancers and NAT gateways, which would
 * otherwise drop it while the sequence works.
 */
export const LOCK_KEEP_ALIVE_MS = 30_000;

/** What an attempt nobody answered most likely means. */
const POOLER_QUEUE_HINT = 'as when a connection pooler has no server connection free';

export interface PgAdvisoryLockOptions {
  readonly connectionString: string;
  readonly logger: BootstrapLogger;
  /** Shown in `pg_stat_activity` for whoever is waiting on us. */
  readonly applicationName: string;
  readonly waitMs?: number;
  readonly attemptMs?: number;
  /** See {@link LOCK_ATTEMPT_GRACE_MS}. */
  readonly attemptGraceMs?: number;
  readonly clock?: Clock;
}

export class LockNotAcquiredError extends Error {
  constructor(
    readonly waitedMs: number,
    holder: string | undefined,
    /** The last attempt went unanswered and was abandoned. */
    unanswered = false,
  ) {
    super(
      `Refusing to boot: could not take the bootstrap advisory lock within ${Math.round(waitedMs / 1000)}s` +
        (holder ? ` (held by ${holder})` : '') +
        (unanswered
          ? `. The database did not answer the last attempt, ${POOLER_QUEUE_HINT}; ` +
            'check what holds the server connections in pg_stat_activity.'
          : '. Another process is still migrating or seeding; check pg_stat_activity.'),
    );
    this.name = 'LockNotAcquiredError';
  }
}

/** The dedicated connection could not be opened within the sequence's budget: the database did not answer. */
export class LockConnectionTimeoutError extends Error {
  constructor(readonly budgetMs: number) {
    super(
      `Refusing to boot: the database did not answer the bootstrap lock's connection within ${Math.round(budgetMs / 1000)}s. ` +
        'Check that it is up and reachable from this process.',
    );
    this.name = 'LockConnectionTimeoutError';
  }
}

/**
 * The lock's connection failed while it held the lock, and a lock ends with
 * its connection: the sequence may have run partly without it, beside another
 * process's. The work it did is not undone; the next boot reads the database
 * afresh.
 */
export class LockLostError extends Error {
  constructor(readonly reason: string) {
    super(
      `Refusing to boot: the bootstrap lock's connection failed while it held the lock (${reason}), so the lock may ` +
        'not have covered the whole sequence. Boot again. If this recurs, look for what ends an idle transaction ' +
        "sooner than a boot takes, such as PgBouncer's idle_transaction_timeout.",
    );
    this.name = 'LockLostError';
  }
}

interface HolderRow {
  pid: number;
  application_name: string;
  state: string | null;
}

/** What a step that ran out of time gives back instead of its result. */
const UNANSWERED = Symbol('unanswered');

/**
 * A transaction-level `pg_advisory_xact_lock`, held in a transaction left
 * open on a dedicated connection until `release` commits it (#236, #596).
 * Dedicated because Prisma's pooled `$executeRaw` may lock on one connection
 * and unlock on another. In an open transaction because a connection pooler in
 * transaction pooling keeps a server connection with its client only while a
 * transaction is open: a session lock goes back to the pooler with its server
 * connection, to whichever client is handed it next. A direct connection and
 * session pooling hold it the same way. The transaction does nothing else; the
 * sequence's work runs on other connections.
 *
 * Each attempt is a genuine blocking wait bounded by `lock_timeout`, set for
 * the attempt's transaction alone, so a concurrent boot is visible in
 * `pg_locks` as an ungranted advisory waiter. An attempt that times out rolls
 * back, and the holder is named in a progress line read outside any
 * transaction, so a waiter holds a server connection only while it attempts.
 * The total wait is bounded by the caller's deadline, or by `DEFAULT_WAIT_MS`
 * without one; reaching it fails the boot with the holder in the message. The
 * last attempt is cut to the time left, so the deadline is honoured to the
 * attempt and not only to the nearest one. A free lock is still taken at the
 * deadline: the attempt then costs nothing, and the caller's final read is
 * what turns "still behind" into the error that names the migration.
 *
 * A step the database does not answer in time (an attempt within its
 * `lock_timeout` and {@link LOCK_ATTEMPT_GRACE_MS}, a read of the holder or the
 * releasing COMMIT within the grace) is abandoned with its connection, and the next attempt opens
 * another. A connection pooler queues a step until a server connection is
 * free, and `lock_timeout` cannot start before one is. Such a step can overrun
 * the deadline by up to the grace, and the holder's read after it by as much
 * again.
 *
 * Connecting spends from the same budget. node-postgres has no connect timeout
 * of its own, so a database that accepts the TCP connection and never answers
 * (a black-holed endpoint, a proxy with nothing behind it) would otherwise hang
 * the boot past any deadline. The client is kept across re-acquires, so this
 * is paid once per sequence unless a step was abandoned.
 *
 * A holder that dies loses the lock with its connection: Postgres ends its
 * transaction, and a pooler closes a server connection whose client left
 * mid-transaction. While the sequence works, the transaction is idle.
 * Postgres's own timeouts are turned off for it, but a pooler set to end idle
 * transactions, or a connection that fails, ends the lock too; `assertHeld`
 * then refuses before the next write, and `release` at the end, with a
 * {@link LockLostError}.
 */
export class PgAdvisoryLock implements BootstrapLock {
  private client: Client | undefined;
  private held = false;
  /** Why the connection failed while the lock was held. */
  private lost: Error | undefined;

  constructor(private readonly options: PgAdvisoryLockOptions) {}

  async acquire(options: LockAcquireOptions = {}): Promise<void> {
    const clock = this.options.clock ?? systemClock;
    const attemptMs = this.options.attemptMs ?? LOCK_ATTEMPT_MS;
    const graceMs = this.options.attemptGraceMs ?? LOCK_ATTEMPT_GRACE_MS;
    const started = clock.now();
    // The earlier of this lock's own limit and the sequence's shared deadline.
    const deadlineAt = Math.min(started + (this.options.waitMs ?? DEFAULT_WAIT_MS), options.deadlineAt ?? Infinity);
    const waitMs = deadlineAt - started;

    for (;;) {
      const client = await this.connect(deadlineAt - clock.now());
      // Never past the deadline: at or after it the attempt is 1ms, which
      // still takes a free lock and only reports a held one.
      const attempt = attemptWithin(attemptMs, deadlineAt - clock.now());

      const taken = await this.abandonUnlessAnswered(client, attempt + graceMs, () => this.attempt(client, attempt));
      if (taken === true) {
        this.held = true;
        return;
      }

      const holders =
        taken === UNANSWERED
          ? UNANSWERED
          : await this.abandonUnlessAnswered(client, graceMs, () => this.holders(client));
      const unanswered = holders === UNANSWERED;
      const holder = unanswered ? undefined : describeHolder(holders);
      const waited = clock.now() - started;

      if (clock.now() >= deadlineAt) {
        throw new LockNotAcquiredError(waited, holder, unanswered);
      }

      const progress = `${Math.round(waited / 1000)}s of ${Math.round(waitMs / 1000)}s`;
      this.options.logger.log(
        unanswered
          ? `Waiting for the bootstrap lock: the database did not answer in time, ${POOLER_QUEUE_HINT}; ` +
              `trying again on a new connection (${progress}).`
          : `Waiting for the bootstrap lock${holder ? ` held by ${holder}` : ''} (${progress}).`,
      );
    }
  }

  /**
   * Commits the transaction holding the lock, which releases it. After a
   * failed acquire, or a second time, this is a no-op, so it sits safely in a
   * `finally`.
   */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    const lost = this.lost;
    this.lost = undefined;
    const client = this.client;
    if (lost || !client) throw new LockLostError(lost?.message ?? 'the connection is gone');

    // Bounded like every other step: a connection that died without a reset
    // would otherwise hold the COMMIT for as long as TCP retries.
    const graceMs = this.options.attemptGraceMs ?? LOCK_ATTEMPT_GRACE_MS;
    let committed: unknown;
    try {
      committed = await this.abandonUnlessAnswered(client, graceMs, () => client.query('COMMIT'));
    } catch (error) {
      throw new LockLostError(error instanceof Error ? error.message : String(error));
    }
    if (committed === UNANSWERED) {
      throw new LockLostError(`the database did not answer the COMMIT within ${graceMs}ms`);
    }
  }

  /**
   * Throws a {@link LockLostError} when the lock's connection has reported a
   * failure since `acquire` took the lock; one it has not reported is found by
   * `release`. A loss reported here leaves `release` nothing to give back.
   */
  assertHeld(): void {
    const lost = this.lost;
    if (!lost) return;
    this.held = false;
    this.lost = undefined;
    throw new LockLostError(lost.message);
  }

  /**
   * Ends the dedicated connection, and with it a transaction still holding
   * the lock; `release` alone keeps it for the wait-and-retry path.
   */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.held = false;
    this.lost = undefined;
    await client?.end();
  }

  /** One attempt: true when the lock was taken, false when `lock_timeout` ran out first. */
  private async attempt(client: Client, attemptMs: number): Promise<boolean> {
    try {
      // One round trip, so a slow link spends little of the grace. Each setting
      // is for this transaction alone: a session setting would stay on a pooled
      // server connection, with whichever client the pooler hands it to next.
      // Postgres's own timeouts are off for the lock: a statement_timeout
      // shorter than the attempt would cancel its wait as an error, and an
      // idle-transaction timeout, or Postgres 17's transaction_timeout, would
      // end the lock while the sequence works. transaction_timeout is set
      // through pg_settings because Postgres before 17 refuses its name.
      await client.query(
        `BEGIN; SET LOCAL lock_timeout = '${attemptMs}ms'; SET LOCAL statement_timeout = 0; ` +
          'SET LOCAL idle_in_transaction_session_timeout = 0; ' +
          "SELECT set_config(name, '0', true) FROM pg_settings WHERE name = 'transaction_timeout'; " +
          `SELECT pg_advisory_xact_lock(hashtextextended(${client.escapeLiteral(BOOTSTRAP_LOCK_NAME)}, 0))`,
      );
      return true;
    } catch (error) {
      // Either way the transaction is aborted; ending it hands back the server connection.
      if (!isLockNotAvailable(error)) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      await client.query('ROLLBACK');
      return false;
    }
  }

  /**
   * `step` on `client`, or {@link UNANSWERED} when the database has not
   * answered within `ms`. The connection is then abandoned: ending it fails
   * whatever is still waiting on it, and the next attempt opens another.
   */
  private async abandonUnlessAnswered<T>(
    client: Client,
    ms: number,
    step: () => Promise<T>,
  ): Promise<T | typeof UNANSWERED> {
    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      if (this.client === client) this.client = undefined;
      client.end().catch(() => undefined);
    }, ms);

    try {
      return await step();
    } catch (error) {
      if (abandoned) return UNANSWERED;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async connect(budgetMs: number): Promise<Client> {
    if (this.client) return this.client;

    const client = new Client({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName,
      // Whole milliseconds and never zero: zero is the driver's "no timeout".
      connectionTimeoutMillis: Math.max(1, Math.ceil(budgetMs)),
      // Idle for the whole sequence: probes keep a load balancer from dropping
      // it, and fail one that died without a reset, which the listener records.
      keepAlive: true,
      keepAliveInitialDelayMillis: LOCK_KEEP_ALIVE_MS,
    });
    // node-postgres emits a failure that no query is waiting on, such as
    // Postgres ending an idle connection; unheard, it would end the process.
    client.on('error', (error) => {
      if (this.client !== client) return;
      this.client = undefined;
      if (this.held) this.lost ??= error;
    });
    try {
      await client.connect();
    } catch (error) {
      if (isConnectTimeout(error)) throw new LockConnectionTimeoutError(budgetMs);
      throw error;
    }
    this.client = client;
    return client;
  }

  private async holders(client: Client): Promise<HolderRow[]> {
    // A bigint advisory key is stored as (classid = high 32 bits, objid = low 32 bits, objsubid = 1).
    // Advisory locks are per database while `pg_locks` lists the whole cluster,
    // so without the database filter the same key held in a neighbouring
    // database (a dev database beside an e2e one) would be named as our blocker.
    const result = await client.query<HolderRow>(
      `SELECT a.pid, a.application_name, a.state
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid = ((hashtextextended($1::text, 0) >> 32) & 4294967295)::oid
          AND l.objid = (hashtextextended($1::text, 0) & 4294967295)::oid`,
      [BOOTSTRAP_LOCK_NAME],
    );
    return result.rows;
  }
}

/**
 * One attempt's `lock_timeout`: the attempt, cut to what is left of the
 * deadline, in whole milliseconds (`lock_timeout` takes no fraction) and never
 * under one, so a free lock is still taken at or past the deadline.
 */
export function attemptWithin(attemptMs: number, remainingMs: number): number {
  return Math.max(1, Math.floor(Math.min(attemptMs, remainingMs)));
}

function isLockNotAvailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === PG.LockNotAvailable;
}

/** node-postgres destroys the socket with exactly this message when `connectionTimeoutMillis` expires; there is no code. */
function isConnectTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout expired';
}

export function describeHolder(rows: readonly HolderRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  return rows
    .map((row) => `pid ${row.pid} (${row.application_name || 'unnamed'}${row.state ? `, ${row.state}` : ''})`)
    .join(', ');
}
