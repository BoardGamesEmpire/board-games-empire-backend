import type { PrismaClient } from '@bge/database';
import { openStandaloneClient } from '@bge/database';
import { afterAll, beforeAll } from '@jest/globals';

/** The harness database's URL, which `global-setup` puts in the environment. */
export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];

  if (!url) {
    throw new Error('DATABASE_URL is not set: did the e2e globalSetup run?');
  }

  return url;
}

export interface TestDatabase {
  readonly client: PrismaClient;
  close(): Promise<void>;
}

/**
 * A client of the harness's database that the spec file owns, for arranging
 * the rows a coordinator boots over and for reading what it wrote. It is
 * `@bge/database`'s standalone client, and lives in the test process: the
 * coordinator keeps its own connections.
 *
 * `close()` ends the pool as well as the client. A pool left open keeps
 * Jest's event loop alive.
 */
export function createTestDatabase(databaseUrl: string = requireDatabaseUrl()): TestDatabase {
  const standalone = openStandaloneClient(databaseUrl);

  return { client: standalone.prisma, close: standalone.close };
}

/**
 * Opens a client for the spec file that calls it, in `beforeAll`, and closes
 * it in `afterAll`. The returned function hands the client out.
 */
export function useTestDatabase(): () => PrismaClient {
  let database: TestDatabase | undefined;

  beforeAll(() => {
    database = createTestDatabase();
  });

  afterAll(async () => {
    const closing = database;
    database = undefined;
    await closing?.close();
  });

  return () => {
    if (database === undefined) {
      throw new Error('The test database is not open: useTestDatabase() opens it in beforeAll');
    }

    return database.client;
  };
}
