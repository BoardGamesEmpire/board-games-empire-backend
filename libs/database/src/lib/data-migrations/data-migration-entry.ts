import type { Logger } from '@nestjs/common';
import type { Prisma } from '../client';

/**
 * One entry of the data-migration registry (#236): a piece of one-time data
 * work, a backfill, a remap, a corrective delta, that a declarative manifest
 * cannot express. The boot sequence applies it once and records it in
 * `data_migrations`; the reference seeds and the catalog reconcile, which run
 * every boot, are for data that converges.
 *
 * `run` receives the transaction its ledger row is written in, so an entry
 * that fails leaves nothing behind, neither its writes nor a row saying it
 * ran. It runs after the seeds and the reconcile, so it may rely on the
 * reference data and the catalog of the build it ships with, and it runs
 * exactly once per database, so it need not be idempotent.
 */
export interface DataMigrationEntry {
  /**
   * `YYYYMMDDHHMMSS_snake_case`, the shape of a Prisma migration's directory,
   * because lexical order is apply order and the two ledgers read alike.
   */
  readonly name: string;
  /**
   * The author's revision of `run`, from 1. Bump it whenever `run` changes.
   * A database that applied an earlier revision then refuses to boot: the
   * edit cannot be applied again there, and pretending it was never made
   * would leave two databases in different states under one name. Fix
   * forward with a new entry instead, and restore the revision.
   */
  readonly revision: number;
  run(tx: Prisma.TransactionClient, logger: Logger): Promise<void>;
}

/** What the planner needs of a `data_migrations` row. */
export interface DataMigrationLedgerRow {
  readonly name: string;
  readonly revision: number;
}
