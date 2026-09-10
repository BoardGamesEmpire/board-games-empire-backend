import { openStandaloneClient, type PrismaClient } from '@bge/database';

/** The harness database's URL, set by the e2e globalSetup; the one every DB-only spec targets. */
export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set — did the e2e globalSetup run?');
  }
  return url;
}

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
 * `@bge/database`'s standalone client, the one its CLIs use (explicit `pg`
 * Pool + `PrismaPg` adapter, honoring a `?schema=` search param), and lives
 * entirely in the test process; the running API keeps its own connections.
 *
 * Callers own the lifecycle: `close()` disconnects the client AND ends the
 * pool — Prisma's `$disconnect()` does not close an app-owned pool, and a
 * leaked pool keeps Jest's event loop alive.
 */
export function createTestDatabase(databaseUrl: string = requireDatabaseUrl()): TestDatabase {
  const standalone = openStandaloneClient(databaseUrl);

  return {
    client: standalone.prisma,
    schema: standalone.schema ?? 'public',
    close: standalone.close,
  };
}
