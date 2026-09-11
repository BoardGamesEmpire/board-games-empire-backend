import type { AppliedMigrationRow, ReconcileCounts } from '@bge/database';
import { performance } from 'node:perf_hooks';

/**
 * The two levels the sequence speaks: progress and outcome on `log`, anything
 * an operator should look at on `warn`. Refusals are thrown, not logged.
 * Structural, so a Nest `Logger` wrapper or a test recorder fits; `fields`
 * is the structured payload of the one summary line and string-only sinks
 * may ignore it.
 */
export interface BootstrapLogger {
  log(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** The rows of `_prisma_migrations`, or none when the table does not exist yet. */
export interface SchemaLedger {
  readApplied(): Promise<AppliedMigrationRow[]>;
}

/**
 * Applies every pending migration. Only the api build has one (#236);
 * its presence is also what makes a process the single writer of the DML
 * phases. `pending` is what the ledger showed before the
 * run, for logging; the runner re-reads the ledger afterwards rather than
 * trusting a return value.
 */
export interface Migrator {
  apply(pending: readonly string[]): Promise<void>;
}

/**
 * How long a process may spend converging before it fails its boot: taking
 * the lock and, for a process without a migrator, waiting for the schema to
 * arrive, out of one budget. Long enough for a first `migrate deploy` on a
 * slow host when the whole compose stack starts at once; a constant, not
 * configuration (#236). The lock falls back to it when acquired without a
 * deadline, so there is one number and no second copy to drift.
 */
export const DEFAULT_WAIT_MS = 10 * 60_000;

export interface LockAcquireOptions {
  /**
   * Absolute time (same clock as {@link Clock.now}) after which acquiring
   * gives up: the sequence's one shared deadline, so a process waiting for
   * the schema does not restart its budget every time it re-takes the lock.
   * Without it the lock bounds itself by {@link DEFAULT_WAIT_MS}.
   */
  readonly deadlineAt?: number;
}

/**
 * The advisory lock around the whole sequence (#236). `acquire` waits, is
 * bounded by `deadlineAt` when given and by {@link DEFAULT_WAIT_MS} otherwise,
 * and throws when the bound is reached. `release` unlocks only what `acquire`
 * took, so it can sit in a `finally` after a failed acquire and run twice.
 */
export interface BootstrapLock {
  acquire(options?: LockAcquireOptions): Promise<void>;
  release(): Promise<void>;
}

/**
 * What the seeds phase reports back and the boot summary carries (#236): the
 * catalog reconcile's writes by table, every count zero on a converged
 * database, and whether the cache flush ran after a reconcile that wrote rows.
 */
export type ReconcileSummary = ReconcileCounts & { readonly cachesFlushed: boolean };

/**
 * The seeds phase: `runSeeds`, the reference seeds and then the catalog
 * reconcile. Not `Seeder`, which `@bge/database` already uses for one seed
 * function.
 */
export interface SeedsPhase {
  run(): Promise<ReconcileSummary>;
}

/**
 * What the data-migrations phase reports back and the boot summary carries
 * (#236): the entries applied, in order; the ledger rows this build's registry
 * does not know, left alone as unknown schema migrations are; and whether the
 * cache flush ran after the entries applied.
 */
export interface DataMigrationsSummary {
  readonly applied: readonly string[];
  readonly unknown: readonly string[];
  readonly cachesFlushed: boolean;
}

/**
 * The data-migrations phase (#236): the registry's entries the `data_migrations`
 * ledger does not record, applied once each in name order after the seeds, so
 * an entry may rely on the reference data and catalog of its own build. A
 * revision mismatch or an entry that fails rejects, and the boot is refused.
 */
export interface DataMigrationsPhase {
  run(): Promise<DataMigrationsSummary>;
}

/**
 * Removes every cached ability graph and API-key scope graph after a reconcile
 * that wrote rows, or a data migration that applied (#236). Only the api build has one, passed by its entrypoint
 * like the migrator; a boot without it leaves the caches to their TTL and the
 * reconcile says so. `flush` resolves to how many keys went and rejects with a
 * {@link CacheFlushError} when it cannot finish; `close` hands the connection
 * back once the sequence is over, used or not.
 */
export interface CacheFlush {
  flush(): Promise<number>;
  close(): Promise<void>;
}

/**
 * A flush that could not finish: the pattern it stopped on and how many keys
 * had already gone, so the log can say which half of the cache is still there
 * rather than that nothing was touched.
 */
export class CacheFlushError extends Error {
  constructor(
    readonly pattern: string,
    readonly removed: number,
    readonly reason: unknown,
  ) {
    super(
      `Cache flush failed on '${pattern}' after removing ${removed} key(s): ` +
        (reason instanceof Error ? reason.message : String(reason)),
    );
    this.name = 'CacheFlushError';
  }
}

/**
 * Injected so the wait-and-retry path is deterministic under test. `now()` is
 * monotonic milliseconds, not wall-clock time: only differences between two
 * readings mean anything, so a clock step while a process boots (NTP settling
 * on a fresh host is the usual one) cannot stretch or shrink a deadline.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
