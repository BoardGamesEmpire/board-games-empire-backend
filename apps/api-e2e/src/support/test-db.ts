import { PrismaClient } from '@bge/database';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { schemaFromDatabaseUrl } from './e2e-env';

export interface TestDatabase {
  readonly client: PrismaClient;
  /** The schema this database URL targets — the scope `resetDatabase` sweeps. */
  readonly schema: string;
  close(): Promise<void>;
}

/**
 * A test-owned Prisma client bound to the harness's ephemeral database.
 *
 * The suite is black-box — specs assert application behavior over HTTP —
 * so this client exists for PLUMBING only: the between-test truncate sweep,
 * arranging fixture rows, and verifying state no endpoint exposes. It is
 * constructed the same way `DatabaseService` builds its client (explicit
 * `pg` Pool + `PrismaPg` adapter, honoring a `?schema=` search param), but
 * lives entirely in the test process; the running API keeps its own
 * connections.
 *
 * Callers own the lifecycle: `close()` disconnects the client AND ends the
 * pool — Prisma's `$disconnect()` does not close an app-owned pool, and a
 * leaked pool keeps Jest's event loop alive.
 */
export function createTestDatabase(databaseUrl: string | undefined = process.env['DATABASE_URL']): TestDatabase {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — did the e2e globalSetup run?');
  }

  const schema = schemaFromDatabaseUrl(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });

  return {
    client,
    schema,
    close: async (): Promise<void> => {
      await client.$disconnect();
      await pool.end();
    },
  };
}
