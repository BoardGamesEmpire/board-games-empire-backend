import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from './client';

export interface StandaloneClient {
  readonly prisma: PrismaClient;
  /** The schema the URL's `?schema=` names; `undefined` leaves it to Postgres's search path (`public`). */
  readonly schema: string | undefined;
  /** Disconnects the client and ends the pool: Prisma's `$disconnect()` does not close an app-owned pool. */
  close(): Promise<void>;
}

/**
 * A client for a process that has one database URL and no Nest context: the
 * CLIs beside `src/` and the e2e harness's plumbing. Built the way
 * `DatabaseService` builds the application's, an explicit `pg` pool and the
 * `PrismaPg` adapter honouring a `?schema=` search param, but without Nest's
 * lifecycle or the configured default schema, which is why that service stays
 * its own construction.
 */
export function openStandaloneClient(databaseUrl: string): StandaloneClient {
  const schema = new URL(databaseUrl).searchParams.get('schema') ?? undefined;
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });

  return {
    prisma,
    schema,
    close: async (): Promise<void> => {
      // The pool is ours whatever Prisma's disconnect does; a CLI that kept it
      // open on the error path would hang at exit instead of reporting the error.
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  };
}
