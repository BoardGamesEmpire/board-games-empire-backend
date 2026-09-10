import type { AppliedMigrationRow } from '@bge/database';

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

export interface LockAcquireOptions {
  /**
   * Absolute time (same clock as {@link Clock.now}) after which acquiring
   * gives up: the sequence's one shared deadline, so a process waiting for
   * the schema does not restart its budget every time it re-takes the lock.
   */
  readonly deadlineAt?: number;
}

/**
 * The advisory lock around the whole sequence (#236). `acquire` waits, is
 * bounded by its own limit and by `deadlineAt` when given, and throws when
 * either is reached; `release` is idempotent enough to sit in a `finally`.
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

/** Injected so the wait-and-retry path is deterministic under test. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
