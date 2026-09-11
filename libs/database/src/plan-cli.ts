// `.env` first: the catalog reaches `@bge/env` and `@bge/logger`, whose
// singletons read the environment at import time.
import 'dotenv/config';

import { openCliClient } from './cli-client';
import { CATALOG_MANIFEST, describePlanReport, loadCatalogSnapshot, planReconcile } from './lib/catalog';
import {
  DATA_MIGRATIONS,
  describeDataMigrationsReport,
  describeMissingLedgerReport,
  describeSkippedDataMigrationsReport,
  planDataMigrations,
  readDataMigrationLedger,
} from './lib/data-migrations';
import { classifyMigrationState, describeSchemaReport, MIGRATION_NAMES, readAppliedMigrations } from './lib/migrations';

/**
 * `npm run db:plan`: what the next api boot would do, without doing it
 * (#236), in the boot's own order. The schema first: `_prisma_migrations`
 * against the migration manifest this build was generated from, classified as
 * the boot classifies it. Over a schema that is behind, or holds a migration
 * that started and never finished, that is the whole report, as it is the
 * whole boot: the api would apply the migrations before any seed, or refuse,
 * and a plan of the catalog over the tables as they stand would describe
 * writes against columns about to change, or fail on ones not yet created.
 * Otherwise the catalog reconcile follows, planned from the live tables by the
 * same planner a boot and `db:seed` apply, and then the data migrations, this
 * build's registry against the `data_migrations` ledger. Over a database ahead
 * of this build the boot skips both, so neither decides the exit code: the
 * catalog is still planned, as `db:seed`'s preview, and the data migrations
 * are not, since no CLI applies them and this build's registry is not the one
 * a newer build's ledger answers to. Nothing here takes the bootstrap lock, so
 * the answer is a reading, not a promise. Exits 0 when the boot would write
 * nothing, 1 when it would (migrations, catalog rows or data migrations), 2
 * when it would refuse (a half-applied migration, a plugin-owned row the
 * manifest claims, an applied data migration at a revision above the ledger's
 * in this build, the ledger table gone), and 3 when no plan could be made, the
 * database being unreadable or the registry malformed, with the error on
 * stderr, so a drift check never mistakes an outage for drift. Runs on the
 * same client as `seed-cli.ts`.
 */
async function main(): Promise<number> {
  const client = openCliClient();

  try {
    const schema = classifyMigrationState(MIGRATION_NAMES, await readAppliedMigrations(client.prisma));
    const schemaReport = describeSchemaReport(schema);
    // Written before the DML halves are planned: should planning them fail,
    // the schema's state is on stdout beside the error on stderr.
    print(schemaReport.lines);

    if (schema.kind === 'behind' || schema.kind === 'failed') {
      return schemaReport.exitCode;
    }

    const catalog = await client.prisma.$transaction(async (tx) =>
      planReconcile(CATALOG_MANIFEST, await loadCatalogSnapshot(tx)),
    );
    const catalogReport = describePlanReport(catalog);
    print(['', ...catalogReport.lines]);

    if (schema.kind === 'ahead') {
      // The boot runs neither DML phase over an ahead database: the catalog
      // plan above is `db:seed`'s, the data migrations are nobody's to run
      // from this build, and the schema's code is the boot's.
      print(['', ...describeSkippedDataMigrationsReport().lines]);
      return schemaReport.exitCode;
    }

    // Outside the transaction: a missing ledger table aborts a Postgres
    // transaction, and the reader turns that one error into a reading.
    const ledger = await readDataMigrationLedger(client.prisma);
    const ledgerReport =
      ledger === undefined
        ? describeMissingLedgerReport(DATA_MIGRATIONS)
        : describeDataMigrationsReport(planDataMigrations(DATA_MIGRATIONS, ledger));
    print(['', ...ledgerReport.lines]);

    return Math.max(schemaReport.exitCode, catalogReport.exitCode, ledgerReport.exitCode);
  } finally {
    // The plan is printed and its code decided; a connection that fails to
    // close afterwards is reported, not mistaken for an unreadable database.
    await client.close().catch((error: unknown) => {
      process.stderr.write(`Closing the connection after the plan failed: ${describe(error)}\n`);
    });
  }
}

function print(lines: readonly string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${describe(error)}\n`);
    process.exitCode = 3;
  },
);
