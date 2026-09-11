// `.env` first: the catalog reaches `@bge/env` and `@bge/logger`, whose
// singletons read the environment at import time.
import 'dotenv/config';

import { openCliClient } from './cli-client';
import { CATALOG_MANIFEST, describePlanReport, loadCatalogSnapshot, planReconcile } from './lib/catalog';

/**
 * `npm run db:plan`: what the next catalog reconcile would write, without
 * writing it (#236). The planner is the one an api boot and `db:seed` apply,
 * run over a snapshot of the live tables; nothing here takes the bootstrap
 * lock, so the answer is a reading, not a promise. Exits 0 when the catalog
 * matches the manifest, 1 when a reconcile would write, 2 when it would refuse
 * (a plugin owns a row the manifest claims), and 3 when the database could not
 * be read, with the error on stderr, so a drift check never mistakes an outage
 * for drift. The schema half of "is this database current?" is
 * `npx prisma migrate status`. Runs on the same client as `seed-cli.ts`.
 */
async function main(): Promise<number> {
  const client = openCliClient();

  try {
    const plan = await client.prisma.$transaction(async (tx) =>
      planReconcile(CATALOG_MANIFEST, await loadCatalogSnapshot(tx)),
    );
    const report = describePlanReport(plan);
    process.stdout.write(`${report.lines.join('\n')}\n`);
    return report.exitCode;
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
