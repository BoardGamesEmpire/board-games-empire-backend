import type { ReconcilePlan } from '@bge/database';
import { CATALOG_MANIFEST, reconcileCatalog, SystemRole } from '@bge/database';
import { runSeeds, SEEDERS } from '@bge/database/seeds';
import type { Logger } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * `runSeeds` against a real database (#236). The reference seeds run first,
 * in `SEEDERS` order, and the catalog reconcile runs last as its own phase:
 * it carries the invalidation port the boot caller passes and its result is
 * the report's, so the boot summary can say what the reconcile wrote.
 *
 * DB-only, on the harness database, which is already migrated and seeded. The
 * between-test sweep preserves the catalog tables, so a spec that removes a
 * grant puts it back by reconciling the shipped manifest.
 */

const silent = { log: () => undefined, warn: () => undefined };

/** `runSeeds` wants a Nest `Logger`; every level is recorded as one line. */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (message: unknown) => void lines.push(String(message));
  return { lines, log: push, debug: push, warn: push, error: push, verbose: push, fatal: push } as unknown as Logger & {
    readonly lines: string[];
  };
}

describe('runSeeds against Postgres', () => {
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

  it('runs the reference seeds in order, then the catalog reconcile, and reports both', async () => {
    const logger = recordingLogger();

    const report = await runSeeds(db.client, logger);

    expect(report.seeds).toEqual(SEEDERS.map((seed) => seed.name));
    expect(report.seeds).not.toContainEqual(expect.stringMatching(/reconcile|permission/i));
    expect(report.reconcile.mutations).toBe(0);

    const lastSeedDone = Math.max(
      ...SEEDERS.map((seed) => logger.lines.findIndex((line) => line.includes(`${seed.name} completed`))),
    );
    // The reconcile's own opening line, not the summary that announces it up front.
    const reconcileStarted = logger.lines.findIndex((line) => /Reconciling the permission catalog/.test(line));
    expect(lastSeedDone).toBeGreaterThanOrEqual(0);
    expect(reconcileStarted).toBeGreaterThan(lastSeedDone);
  });

  it('hands the reconcile the invalidation port: called once with the plan when it wrote, never when it did not', async () => {
    const calls: ReconcilePlan[] = [];
    const invalidate = async (plan: ReconcilePlan): Promise<void> => void calls.push(plan);

    const converged = await runSeeds(db.client, recordingLogger(), { invalidate });
    expect(converged.reconcile.invalidated).toBe(false);
    expect(calls).toEqual([]);

    await db.client.rolePermission.deleteMany({
      where: { role: { name: SystemRole.User }, permission: { slug: 'read:game' } },
    });
    const restored = await runSeeds(db.client, recordingLogger(), { invalidate });

    expect(restored.reconcile.mutations).toBe(1);
    expect(restored.reconcile.invalidated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rolePermissions.create).toEqual([{ roleName: 'User', permissionSlug: 'read:game' }]);
  });
});
