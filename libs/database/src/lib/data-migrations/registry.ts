import type { DataMigrationEntry } from './data-migration-entry';

/**
 * The one-time data migrations this build ships (#236). The api's boot
 * sequence applies each one once, after the seeds and the catalog reconcile,
 * in one transaction with its `data_migrations` row; `npm run db:plan` lists
 * the pending ones. Empty until the first backfill needs it: the ledger exists
 * so that day has somewhere to write.
 *
 * To add one: a file beside this one exporting a `DataMigrationEntry` named
 * `YYYYMMDDHHMMSS_snake_case` at `revision: 1`, whose `run` does the work on
 * the transaction it is given, listed here in any order (the name orders it).
 * If `run` changes after the entry has run anywhere, bump `revision`; the
 * databases that applied the old one then refuse to boot, which is the point,
 * and the fix is a new entry, not an edit.
 */
export const DATA_MIGRATIONS: readonly DataMigrationEntry[] = [];
