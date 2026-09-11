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

/**
 * `npm run db:plan`: what the next api boot would write, without writing it
 * (#236). Two halves, both read from the live tables: the catalog reconcile,
 * planned by the same planner a boot and `db:seed` apply, and the data
 * migrations, this build's registry against the `data_migrations` ledger.
 * Nothing here takes the bootstrap lock, so the answer is a reading, not a
 * promise. Exits 0 when both halves are converged, 1 when either would write
 * (a database without the `data_migrations` table yet counts: its schema is
 * behind), 2 when the boot would refuse (a plugin owns a row the manifest
 * claims, or an applied data migration differs in revision from the ledger),
 * and 3 when no plan could be made, the database being unreadable or the
 * registry malformed, with the error on stderr, so a drift check never
 * mistakes an outage for drift. The schema half of "is this database
 * current?" is `npx prisma migrate status`. Runs on the same client as
 * `seed-cli.ts`.
 */
async function main(): Promise<number> {
  const client = openCliClient();

  try {
    const catalog = await client.prisma.$transaction(async (tx) =>
      planReconcile(CATALOG_MANIFEST, await loadCatalogSnapshot(tx)),
    );
    // Outside the transaction: a missing ledger table (schema behind) aborts a
    // Postgres transaction, and the reader turns that one error into a reading.
    const ledger = await readDataMigrationLedger(client.prisma);

    const catalogReport = describePlanReport(catalog);
    const ledgerReport =
      ledger === undefined
        ? describeMissingLedgerReport(DATA_MIGRATIONS)
        : describeDataMigrationsReport(planDataMigrations(DATA_MIGRATIONS, ledger));

    const lines = [
      ...catalogReport.lines,
      '',
      ...ledgerReport.lines,
      '',
      'Schema: this covers the catalog and the data migrations; `npx prisma migrate status` reports pending migrations.',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return Math.max(catalogReport.exitCode, ledgerReport.exitCode);
  } finally {
    // The plan is printed and its code decided; a connection that fails to
    // close afterwards is reported, not mistaken for an unreadable database.
    await client.close().catch((error: unknown) => {
      process.stderr.write(`Closing the connection after the plan failed: ${describe(error)}\n`);
    });
  }
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
