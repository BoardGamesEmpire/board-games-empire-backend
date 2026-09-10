// `.env` first: the seeds reach `@bge/env` and `@bge/logger`, whose singletons
// read the environment at import time.
import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from './lib/client';
import { runSeeds } from './lib/seeds';

/**
 * CLI entrypoint only (`npm run db:seed` / `npx prisma db seed`); it is the
 * command `prisma.config.ts` points at, run with `tsx`. Nothing imports it.
 *
 * It lives inside `@bge/database` rather than under `prisma/` so the lib's
 * `typecheck` covers it (#433): `tsx` strips types without checking them, and
 * a file outside every TypeScript project is compiled by nobody. The seed set
 * and the loop are `./lib/seeds`, the same `runSeeds` the boot sequence runs.
 *
 * The client is built the way `DatabaseService` and the e2e harness build
 * theirs, an explicit `pg` pool and the `PrismaPg` adapter honouring a
 * `?schema=` search param, without a Nest context: a seed needs a database URL
 * and nothing else.
 */
async function seed(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. `.env` is loaded above; set the variable or run through `prisma db seed`.',
    );
  }

  const pool = new Pool({ connectionString: url });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema: new URL(url).searchParams.get('schema') ?? undefined }),
  });

  try {
    await runSeeds(prisma, new Logger('Seed'));
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

seed().catch((error: unknown) => {
  Logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), 'Seed');
  process.exitCode = 1;
});
