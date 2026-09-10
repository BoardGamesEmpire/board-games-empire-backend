// `.env` first: the seeds reach `@bge/env` and `@bge/logger`, whose singletons
// read the environment at import time.
import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { openCliClient } from './cli-client';
import { runSeeds } from './lib/seeds';

/**
 * CLI entrypoint only (`npm run db:seed` / `npx prisma db seed`); it is the
 * command `prisma.config.ts` points at, run with `tsx`. Nothing imports it.
 *
 * It lives inside `@bge/database` rather than under `prisma/` so the lib's
 * `typecheck` covers it (#433): `tsx` strips types without checking them, and
 * a file outside every TypeScript project is compiled by nobody. The seed set
 * and the loop are `./lib/seeds`, the same `runSeeds` the boot sequence runs;
 * the client is `./cli-client`, shared with `plan-cli.ts`.
 */
async function seed(): Promise<void> {
  const client = openCliClient();

  try {
    await runSeeds(client.prisma, new Logger('Seed'));
  } finally {
    await client.close();
  }
}

seed().catch((error: unknown) => {
  Logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), 'Seed');
  process.exitCode = 1;
});
