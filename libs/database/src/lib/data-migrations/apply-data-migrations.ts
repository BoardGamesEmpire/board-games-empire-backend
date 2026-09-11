import type { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { PrismaClient } from '../client';
import type { DataMigrationEntry } from './data-migration-entry';
import { describeMismatch, planDataMigrations, type RevisionMismatch } from './plan-data-migrations';
import { readDataMigrationLedger } from './read-data-migration-ledger';

/** What the apply needs of the client: the ledger model and interactive transactions. */
export type DataMigrationsClient = Pick<PrismaClient, '$transaction' | 'dataMigration'>;

export interface DataMigrationsResult {
  /** The entries this call applied, in order. */
  readonly applied: readonly string[];
  /** Ledger rows this build's registry does not know; reported, never touched. */
  readonly unknown: readonly string[];
  /** Whether the invalidation port ran after the entries applied; false when none did, or no port was given. */
  readonly invalidated: boolean;
}

export interface ApplyDataMigrationsOptions {
  /**
   * Called once after the last entry that applied, whether the loop then
   * finished or a later entry failed; never when none did. A data migration
   * may rewrite anything the cached ability graphs are derived from, so the
   * call is not conditioned on what the entries touched: the boot sequence
   * passes its cache flush, and the entries are rare enough that a flush per
   * boot that applied one costs nothing worth saving.
   */
  readonly invalidate?: () => Promise<void>;
}

/**
 * How long one entry's transaction may run. A backfill is the one boot phase
 * whose work grows with the data, and Prisma closes an interactive
 * transaction after five seconds by default, which would fail the first real
 * one. A cap on a hung entry, not a budget: the boot's wait budget bounds how
 * long a process waits for others, never its own work, so an entry holds the
 * bootstrap lock for as long as it runs and the processes waiting for it spend
 * their budget on that, as they do on a first `migrate deploy`. A constant, not
 * configuration (#236).
 */
export const DATA_MIGRATION_TIMEOUT_MS = 10 * 60_000;

/**
 * An applied entry is at another revision in this build than in the ledger.
 * Either its code changed after it ran, without a new entry, or this build is a
 * rollback across such an edit. Nothing can run again over data another
 * revision already shaped, and ignoring the difference would leave two
 * databases in different states under one name, so the boot refuses, and the
 * message says what to do in each direction.
 */
export class DataMigrationRevisionError extends Error {
  constructor(readonly mismatched: readonly RevisionMismatch[]) {
    super(
      `Refusing to boot: ${mismatched.length} applied data migration(s) differ in revision from the ledger: ` +
        mismatched.map(describeMismatch).join('; ') +
        '. A one-time migration does not run twice. An entry edited after it ran is restored to the revision that ran ' +
        "and fixed forward with a new entry; a ledger revision above the build's means a newer build ran the entry, " +
        'and that build owns the data.',
    );
    this.name = 'DataMigrationRevisionError';
  }
}

/**
 * Applies every registry entry the ledger does not record, in name order,
 * each in one transaction with its `data_migrations` row (#236). Runs under
 * the bootstrap lock, after the seeds and the catalog reconcile, so an entry
 * sees the reference data of its own build. A revision mismatch refuses before
 * anything runs; an entry that throws stops the loop with its transaction
 * rolled back, so the ledger never names work that did not land, and the
 * entries before it stay applied, each having committed on its own. The
 * invalidation port runs once, after the last entry that applied, and so also
 * when a later entry fails: this process then refuses to boot and serves
 * nothing, but the api processes already serving hold graphs built before the
 * committed entries ran, and only the TTL would otherwise end them.
 */
export async function applyDataMigrations(
  client: DataMigrationsClient,
  entries: readonly DataMigrationEntry[],
  logger: Logger,
  options: ApplyDataMigrationsOptions = {},
): Promise<DataMigrationsResult> {
  const rows = await readDataMigrationLedger(client);
  if (rows === undefined) {
    throw new Error(
      'The data_migrations table does not exist: the schema is behind this build. Apply the migrations first.',
    );
  }
  const plan = planDataMigrations(entries, rows);

  if (plan.mismatched.length > 0) {
    throw new DataMigrationRevisionError(plan.mismatched);
  }

  if (plan.unknown.length > 0) {
    logger.warn(
      `The ledger records ${plan.unknown.length} data migration(s) this build does not know (${plan.unknown.join(', ')}). ` +
        'Left alone: a newer build applied them, or an entry was removed after it ran.',
    );
  }

  if (plan.pending.length === 0) {
    // The count is of this build's entries; the rows it does not know are the
    // warning above, and named here so the line never reads as a fresh ledger.
    const unknown = plan.unknown.length > 0 ? `, ${plan.unknown.length} row(s) this build does not know` : '';
    logger.log(`Data migrations: none pending (${plan.applied.length} applied${unknown}).`);
    return { applied: [], unknown: plan.unknown, invalidated: false };
  }

  logger.log(
    `Data migrations: ${plan.pending.length} pending (${plan.pending.map((entry) => entry.name).join(', ')}); applying in order.`,
  );

  const applied: string[] = [];
  try {
    for (const entry of plan.pending) {
      // The line saying it applied waits for the commit: a transaction that fails
      // to commit has applied nothing, and the log must not say otherwise.
      const durationMs = await client.$transaction(
        async (tx) => {
          const started = performance.now();
          await entry.run(tx, logger);
          const elapsed = Math.round(performance.now() - started);
          await tx.dataMigration.create({ data: { name: entry.name, revision: entry.revision, durationMs: elapsed } });
          return elapsed;
        },
        { timeout: DATA_MIGRATION_TIMEOUT_MS },
      );
      applied.push(entry.name);
      logger.log(`Data migration '${entry.name}' applied at revision ${entry.revision} in ${durationMs}ms.`);
    }
  } catch (error) {
    // The entry that threw rolled back with its row, but the ones before it
    // committed, and the caches do not know that yet. The boot refuses either
    // way; the flush is for the processes that keep serving.
    if (applied.length > 0) {
      await invalidateAfter(applied, options, logger);
    }
    throw error;
  }

  const invalidated = await invalidateAfter(applied, options, logger);
  return { applied, unknown: plan.unknown, invalidated };
}

/**
 * Runs the invalidation port for the entries that committed, and says whether
 * it ran. Never throws: the entries are committed and the next boot finds them
 * applied, so failing here would lose the only chance to say the caches were
 * missed, and the TTL bounds the staleness either way, as after the reconcile.
 */
async function invalidateAfter(
  applied: readonly string[],
  options: ApplyDataMigrationsOptions,
  logger: Logger,
): Promise<boolean> {
  const count = `${applied.length} data migration(s) applied`;
  if (!options.invalidate) {
    logger.warn(
      `${count} but no invalidation port was supplied: cached ability graphs were not touched and expire on their own TTL.`,
    );
    return false;
  }
  try {
    await options.invalidate();
    return true;
  } catch (error) {
    logger.warn(
      `${count} but the invalidation port failed (${describeError(error)}): whatever it did not evict expires on its own TTL.`,
    );
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
