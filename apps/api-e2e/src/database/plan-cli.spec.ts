import { CATALOG_MANIFEST, reconcileCatalog, SystemRole } from '@bge/database';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { createTestDatabase, requireDatabaseUrl, type TestDatabase } from '../support/test-db';

/**
 * `npm run db:plan` against a real database (#236): the plan-only CLI over
 * the exported planner. It prints what the next reconcile would write and
 * exits 0 when the catalog is converged, 1 when it would write, 2 when it
 * would refuse, 3 when it could not read the database; the schema half is
 * `prisma migrate status`, which the output points at. Spawned as the npm
 * script itself, so the entry in package.json is what is tested, with the
 * database chosen through the child's environment. Stderr is not asserted
 * empty: npm, Node and the loader write notices there that say nothing about
 * the CLI.
 */

/** apps/api-e2e/src/database → workspace root; where package.json and the CLI live. */
const WORKSPACE_ROOT = path.join(__dirname, '..', '..', '..', '..');
const silent = { log: () => undefined, warn: () => undefined };

function plan(databaseUrl: string) {
  const result = spawnSync('npm', ['run', '--silent', 'db:plan'], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('db:plan against Postgres', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterEach(async () => {
    await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });
  });

  afterAll(async () => {
    await db.close();
  });

  it('reports a converged catalog, writes nothing, and exits 0', async () => {
    const before = await db.client.rolePermission.count();

    const result = plan(requireDatabaseUrl());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Catalog reconcile: permissions +0 ~0 revived 0 retired 0; roles +0 ~0; grants +0 -0',
    );
    expect(result.stdout).toMatch(/nothing to write/i);
    expect(result.stdout).toContain('prisma migrate status');
    expect(await db.client.rolePermission.count()).toBe(before);
  });

  it('names the writes a reconcile would make, leaves them unmade, and exits 1', async () => {
    await db.client.rolePermission.deleteMany({
      where: { role: { name: SystemRole.User }, permission: { slug: 'read:game' } },
    });

    const result = plan(requireDatabaseUrl());

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('grants +1 -0');
    expect(
      await db.client.rolePermission.count({
        where: { role: { name: SystemRole.User }, permission: { slug: 'read:game' } },
      }),
    ).toBe(0);
  });

  it('exits 3 with the error on stderr when the database cannot be read, so an outage never reads as drift', () => {
    const result = plan('postgresql://nobody:nothing@127.0.0.1:1/none');

    expect(result.status).toBe(3);
    expect(result.stderr).not.toBe('');
  });
});
