import type { AppliedMigrationRow } from '@bge/database';
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
 * The seeds phase: `runSeeds`, which today includes the catalog reconcile.
 * Not `Seeder`, which `@bge/database` already uses for one seed function.
 */
export interface SeedsPhase {
  run(): Promise<void>;
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
