import { resetDatabase } from './database-reset';
import { createTestDatabase, type TestDatabase } from './test-db';

/**
 * Wires the between-test isolation sweep (#255) into every spec file via
 * `setupFilesAfterEnv`. Without this hook the sweep is documentation, not
 * behavior: nothing else runs `resetDatabase` between tests, so any spec
 * that writes rows leaks them into every test that follows.
 *
 * One plumbing client per spec file (opened lazily on the first test's
 * `beforeEach`, closed in `afterAll`), one sweep before every test. With
 * `maxWorkers: 1` the files run serially, so a single connection is ever
 * open. Redis is NOT swept here. Clearing it would destroy sessions a suite
 * may deliberately carry across tests (e.g. sign-in once in `beforeAll`,
 * exercise endpoints per test), and obliterating every queue before every
 * test would remove jobs a running worker holds. Queue cleanup is an opt-in
 * per suite instead: `isolateQueue` for a queue a spec fills, `useWorker` for
 * the queues its worker consumes.
 */
let db: TestDatabase | undefined;

beforeEach(async () => {
  db ??= createTestDatabase();
  await resetDatabase(db.client, db.schema);
});

afterAll(async () => {
  await db?.close();
  db = undefined;
});
