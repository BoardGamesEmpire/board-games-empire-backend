// `.env` first: the catalog reaches `@bge/env` and `@bge/logger`, whose
// singletons read the environment at import time.
import 'dotenv/config';

import { openCliClient } from './cli-client';
import { CATALOG_MANIFEST, describePlanReport, loadCatalogSnapshot, planReconcile } from './lib/catalog';
import {
  DATA_MIGRATIONS,
  describeDataMigrationsReport,
  describeMissingLedgerReport,
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
 * Otherwise the two DML halves follow, both read from the live tables: the
 * catalog reconcile, planned by the same planner a boot and `db:seed` apply,
 * and the data migrations, this build's registry against the `data_migrations`
 * ledger. Over a database ahead of this build both are printed as `db:seed`'s
 * preview, but the boot skips them, so they do not decide the exit code.
 * Nothing here takes the bootstrap lock, so the answer is a reading, not a
 * promise. Exits 0 when the boot would write nothing, 1 when it would
 * (migrations, catalog rows or data migrations), 2 when it would refuse (a
 * half-applied migration, a plugin-owned row the manifest claims, an applied
 * data migration at another revision, the ledger table gone), and 3 when no
 * plan could be made, the database being unreadable or the registry
 * malformed, with the error on stderr, so a drift check never mistakes an
 * outage for drift. Runs on the same client as `seed-cli.ts`.
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
    // Outside the transaction: a missing ledger table aborts a Postgres
    // transaction, and the reader turns that one error into a reading.
    const ledger = await readDataMigrationLedger(client.prisma);

    const catalogReport = describePlanReport(catalog);
    const ledgerReport =
      ledger === undefined
        ? describeMissingLedgerReport(DATA_MIGRATIONS)
        : describeDataMigrationsReport(planDataMigrations(DATA_MIGRATIONS, ledger));
    print(['', ...catalogReport.lines, '', ...ledgerReport.lines]);

    // Over an ahead database the boot runs neither DML phase: the plans above
    // are `db:seed`'s, and the schema's code is the boot's.
    return schema.kind === 'ahead'
      ? schemaReport.exitCode
      : Math.max(schemaReport.exitCode, catalogReport.exitCode, ledgerReport.exitCode);
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
