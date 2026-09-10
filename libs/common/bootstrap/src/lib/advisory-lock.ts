import { Client } from 'pg';
import type { BootstrapLock, BootstrapLogger, Clock, LockAcquireOptions } from './ports';
import { systemClock } from './ports';

/**
 * The lock's name; the bigint key is `hashtextextended(name, 0)`, computed by
 * Postgres so it cannot collide with Prisma Migrate's own advisory key and so
 * a test can compute exactly the same value.
 */
export const BOOTSTRAP_LOCK_NAME = 'bge:bootstrap';

/** How long one blocking attempt waits before the progress log names the holder. */
export const LOCK_ATTEMPT_MS = 5_000;
/** How long, in total, a process waits for the lock before failing its boot. */
export const DEFAULT_LOCK_WAIT_MS = 10 * 60_000;

/** Postgres `lock_not_available`, raised when `lock_timeout` expires. */
const LOCK_NOT_AVAILABLE = '55P03';

export interface PgAdvisoryLockOptions {
  readonly connectionString: string;
  readonly logger: BootstrapLogger;
  /** Shown in `pg_stat_activity` for whoever is waiting on us. */
  readonly applicationName: string;
  readonly waitMs?: number;
  readonly attemptMs?: number;
  readonly clock?: Clock;
}

export class LockNotAcquiredError extends Error {
  constructor(
    readonly waitedMs: number,
    holder: string | undefined,
  ) {
    super(
      `Refusing to boot: could not take the bootstrap advisory lock within ${Math.round(waitedMs / 1000)}s` +
        (holder ? ` (held by ${holder})` : '') +
        '. Another process is still migrating or seeding, or died holding a session lock; check pg_stat_activity.',
    );
    this.name = 'LockNotAcquiredError';
  }
}

interface HolderRow {
  pid: number;
  application_name: string;
  state: string | null;
  held_for: string | null;
}

/**
 * A session-level `pg_advisory_lock` on a dedicated connection (#236).
 * Dedicated because Prisma's pooled `$executeRaw` may lock on one connection
 * and unlock on another; session-level because the sequence spans a child
 * process and several transactions.
 *
 * Each attempt is a genuine blocking wait bounded by `lock_timeout`, so a
 * concurrent boot is visible in `pg_locks` as an ungranted advisory waiter;
 * between attempts the holder is named in a progress line. The total wait is
 * bounded; reaching it fails the boot with the holder in the message. The
 * last attempt is cut to the time left, so the deadline is honoured to the
 * attempt and not only to the nearest one. A free lock is still taken at the
 * deadline: the attempt then costs nothing, and the caller's final read is
 * what turns "still behind" into the error that names the migration.
 *
 * Connecting is not budgeted: it happens once per sequence (the client is
 * kept across re-acquires) and the driver's own connect timeout bounds it well
 * inside any deadline this lock is given.
 */
export class PgAdvisoryLock implements BootstrapLock {
  private client: Client | undefined;
  private key: string | undefined;

  constructor(private readonly options: PgAdvisoryLockOptions) {}

  async acquire(options: LockAcquireOptions = {}): Promise<void> {
    const client = await this.connect();
    const key = await this.lockKey(client);
    const clock = this.options.clock ?? systemClock;
    const attemptMs = this.options.attemptMs ?? LOCK_ATTEMPT_MS;
    const started = clock.now();
    // The earlier of this lock's own limit and the sequence's shared deadline.
    const deadlineAt = Math.min(
      started + (this.options.waitMs ?? DEFAULT_LOCK_WAIT_MS),
      options.deadlineAt ?? Infinity,
    );
    const waitMs = deadlineAt - started;

    for (;;) {
      // Never past the deadline: the attempt is the shorter of its own length
      // and what is left. At or after the deadline it is 1ms, which still
      // takes a free lock and only reports a held one.
      const attempt = Math.max(1, Math.floor(Math.min(attemptMs, deadlineAt - clock.now())));
      await client.query(`SET lock_timeout = '${attempt}ms'`);

      try {
        await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
        return;
      } catch (error) {
        if (!isLockNotAvailable(error)) throw error;
      }

      const waited = clock.now() - started;
      const holder = describeHolder(await this.holders(client, key));

      if (clock.now() >= deadlineAt) {
        throw new LockNotAcquiredError(waited, holder);
      }

      this.options.logger.log(
        `Waiting for the bootstrap lock${holder ? ` held by ${holder}` : ''} (${Math.round(waited / 1000)}s of ${Math.round(waitMs / 1000)}s).`,
      );
    }
  }

  async release(): Promise<void> {
    if (!this.client || !this.key) return;
    await this.client.query('SELECT pg_advisory_unlock($1::bigint)', [this.key]);
  }

  /** Ends the dedicated connection; `release` alone keeps it for the wait-and-retry path. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.key = undefined;
    await client?.end();
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;

    const client = new Client({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName,
    });
    await client.connect();
    this.client = client;
    return client;
  }

  private async lockKey(client: Client): Promise<string> {
    if (this.key) return this.key;
    const result = await client.query<{ key: string }>('SELECT hashtextextended($1::text, 0)::text AS key', [
      BOOTSTRAP_LOCK_NAME,
    ]);
    this.key = result.rows[0].key;
    return this.key;
  }

  private async holders(client: Client, key: string): Promise<HolderRow[]> {
    // A bigint advisory key is stored as (classid = high 32 bits, objid = low 32 bits, objsubid = 1).
    // Advisory locks are per database while `pg_locks` lists the whole cluster,
    // so without the database filter the same key held in a neighbouring
    // database (a dev database beside an e2e one) would be named as our blocker.
    const result = await client.query<HolderRow>(
      `SELECT a.pid, a.application_name, a.state, (now() - a.query_start)::text AS held_for
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND l.classid = (($1::bigint >> 32) & 4294967295)::oid
          AND l.objid = ($1::bigint & 4294967295)::oid`,
      [key],
    );
    return result.rows;
  }
}

function isLockNotAvailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

export function describeHolder(rows: readonly HolderRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  return rows
    .map((row) => `pid ${row.pid} (${row.application_name || 'unnamed'}${row.state ? `, ${row.state}` : ''})`)
    .join(', ');
}
