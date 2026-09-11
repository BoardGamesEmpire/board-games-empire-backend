import { CATALOG_MANIFEST, MIGRATION_NAMES, reconcileCatalog, SystemRole } from '@bge/database';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { createTestDatabase, requireDatabaseUrl, type TestDatabase } from '../support/test-db';

/**
 * `npm run db:plan` against a real database (#236): the plan-only CLI in the
 * boot's order. It reads `_prisma_migrations` against the build's migration
 * manifest first and, over a schema in sync or ahead, plans the catalog
 * reconcile and the data migrations over the live tables; over one behind or
 * half-applied it stops at the schema, as the boot would migrate or refuse
 * before any seed. Exits 0 when the boot would write nothing, 1 when it
 * would, 2 when it would refuse, 3 when no plan could be made, the database
 * unreadable or the registry malformed. Spawned as the npm script itself, so
 * the entry in package.json is what is tested, with the database chosen
 * through the child's environment. Stderr is not asserted empty: npm, Node
 * and the loader write notices there that say nothing about the CLI. The rows
 * a test adds to `_prisma_migrations`, a table the between-test sweep
 * preserves, are removed here.
 */

/** apps/api-e2e/src/database → workspace root; where package.json and the CLI live. */
const WORKSPACE_ROOT = path.join(__dirname, '..', '..', '..', '..');
const silent = { log: () => undefined, warn: () => undefined };
/** A ledger row this build's registry does not know; written by one test, removed after it. */
const UNKNOWN_ROW = '20260905000000_e2e_newer_build';
/** Finished in the database, unknown to this build: what a newer build's migration, or a rollback, leaves behind. */
const UNKNOWN_MIGRATION = '20990101000000_e2e_from_a_newer_build';
/** Started and neither finished nor rolled back: what a killed `migrate deploy` leaves behind. */
const UNFINISHED_MIGRATION = '20990102000000_e2e_never_finished';

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
    await db.client.dataMigration.deleteMany({ where: { name: UNKNOWN_ROW } });
    await db.client.$executeRawUnsafe('DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])', [
      UNKNOWN_MIGRATION,
      UNFINISHED_MIGRATION,
    ]);
  });

  afterAll(async () => {
    await db.close();
  });

  /** A row as `migrate deploy` writes one: finished, or started and left. */
  async function insertMigrationRow(name: string, finished: boolean): Promise<void> {
    await db.client.$executeRawUnsafe(
      'INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) ' +
        'VALUES ($1, $2, $3, now(), $4, $5)',
      randomUUID(),
      'e2e',
      name,
      finished ? new Date() : null,
      finished ? 1 : 0,
    );
  }

  const readGameGrant = { where: { role: { name: SystemRole.User }, permission: { slug: 'read:game' } } };

  it('reports an in-sync schema and a converged catalog, writes nothing, and exits 0', async () => {
    const before = await db.client.rolePermission.count();

    const result = plan(requireDatabaseUrl());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Schema: in sync with this build.');
    expect(result.stdout).toContain(
      'Catalog reconcile: permissions +0 ~0 revived 0 retired 0; roles +0 ~0; grants +0 -0',
    );
    expect(result.stdout).toMatch(/nothing to write/i);
    expect(result.stdout).toContain('Data migrations: none pending.');
    expect(await db.client.rolePermission.count()).toBe(before);
  });

  it('names the writes a reconcile would make, leaves them unmade, and exits 1', async () => {
    await db.client.rolePermission.deleteMany(readGameGrant);

    const result = plan(requireDatabaseUrl());

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('grants +1 -0');
    expect(await db.client.rolePermission.count(readGameGrant)).toBe(0);
  });

  it('names a ledger row this build does not know, leaves it alone, and still exits 0', async () => {
    await db.client.dataMigration.create({
      data: { name: UNKNOWN_ROW, revision: 1, durationMs: 0 },
    });

    const result = plan(requireDatabaseUrl());

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/registry does not know/);
    expect(result.stdout).toContain(`  ${UNKNOWN_ROW}`);
    expect(await db.client.dataMigration.count({ where: { name: UNKNOWN_ROW } })).toBe(1);
  });

  it('plans the catalog over a database that is ahead, as db:seed would write it, and exits 0 since the boot skips it', async () => {
    await insertMigrationRow(UNKNOWN_MIGRATION, true);
    await db.client.rolePermission.deleteMany(readGameGrant);

    const result = plan(requireDatabaseUrl());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`  ${UNKNOWN_MIGRATION}`);
    expect(result.stdout).toContain('grants +1 -0');
    expect(result.stdout).toContain(
      'Schema: ahead by 1 migration(s); the boot skips the seeds and the data migrations.',
    );
    expect(await db.client.rolePermission.count(readGameGrant)).toBe(0);
  });

  it('stops at the schema over a migration that started and never finished, and exits 2', async () => {
    await insertMigrationRow(UNFINISHED_MIGRATION, false);

    const result = plan(requireDatabaseUrl());

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/would REFUSE to boot/);
    expect(result.stdout).toContain(`prisma migrate resolve --rolled-back ${UNFINISHED_MIGRATION}`);
    expect(result.stdout).not.toContain('Catalog reconcile:');
  });

  it('stops at the schema when it is behind, naming the pending migration, and exits 1', async () => {
    const last = MIGRATION_NAMES.at(-1);
    if (last === undefined) throw new Error('the migration manifest is empty');
    const [row] = await db.client.$queryRawUnsafe<Array<{ finished_at: Date }>>(
      'SELECT finished_at FROM _prisma_migrations WHERE migration_name = $1',
      last,
    );
    if (row === undefined) throw new Error(`the harness database has no row for ${last}`);
    // Marked rolled back, as `prisma migrate resolve --rolled-back` marks a
    // failed migration for `migrate deploy` to retry; the classifier reads
    // that as pending. Restored exactly, as the harness database is shared.
    await db.client.$executeRawUnsafe(
      'UPDATE _prisma_migrations SET finished_at = NULL, rolled_back_at = now() WHERE migration_name = $1',
      last,
    );
    try {
      const result = plan(requireDatabaseUrl());

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('The next api boot would apply 1 migration(s) before the seeds, in this order:');
      expect(result.stdout).toContain(`  ${last}`);
      expect(result.stdout).toContain('Schema: behind by 1 migration(s).');
      expect(result.stdout).not.toContain('Catalog reconcile:');
    } finally {
      await db.client.$executeRawUnsafe(
        'UPDATE _prisma_migrations SET finished_at = $2, rolled_back_at = NULL WHERE migration_name = $1',
        last,
        row.finished_at,
      );
    }
  });

  it('exits 3 with the error on stderr when the database cannot be read, so an outage never reads as drift', () => {
    const result = plan('postgresql://nobody:nothing@127.0.0.1:1/none');

    expect(result.status).toBe(3);
    expect(result.stderr).not.toBe('');
  });
});
