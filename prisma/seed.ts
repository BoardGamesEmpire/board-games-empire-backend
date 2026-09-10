// `.env` first: `@bge/database` reaches `@bge/env` and `@bge/logger`, whose
// singletons read the environment at import time.
import 'dotenv/config';

import { PrismaClient } from '@bge/database';
import { runSeeds } from '@bge/database/seeds';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * CLI entrypoint only (`npm run db:seed` / `npx prisma db seed`). The seed set
 * and the loop live in `@bge/database` (`libs/database/src/lib/seeds`, moved
 * there by #236 so they are typechecked and importable by the boot sequence,
 * which runs the same `runSeeds`); this file is the thin wrapper
 * `prisma.config.ts` points at. It builds its client the way `DatabaseService`
 * and the e2e harness do — an explicit `pg` pool and the `PrismaPg` adapter,
 * honouring a `?schema=` search param — without a Nest context, because a seed
 * needs a database URL and nothing else.
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
