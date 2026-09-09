import type { CatalogManifest, ReconcilePlan } from '@bge/database';
import {
  CATALOG_MANIFEST,
  CatalogReconcileConflictError,
  PermissionOwner,
  reconcileCatalog,
  RiskLevel,
  SystemRole,
} from '@bge/database';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The catalog reconciler against a real database (#235).
 *
 * `planReconcile` is pure and every row of its decision table is a unit test
 * in `@bge/database`. What only Postgres can show is the apply: that a plan's
 * writes land, that a refused plan writes nothing, that a retired row is the
 * SAME row when its slug returns, and that a second run over the shipped
 * catalog is a no-op — the property the seed relies on every time it runs.
 *
 * DB-only, like `deadlock-shape.spec.ts`: no HTTP, so `requireBaseUrl` is not
 * called. The harness has already migrated and seeded the database, and the
 * between-test sweep preserves the three catalog tables, so each spec here
 * mutates them and puts them back — by reconciling the shipped manifest, which
 * is also the proof the restore worked.
 */

const silent = { log: () => undefined, warn: () => undefined };

/** The shipped manifest with one permission gone — from the catalog and from every role that held it. */
function without(slug: string): CatalogManifest {
  return {
    permissions: CATALOG_MANIFEST.permissions.filter((permission) => permission.slug !== slug),
    roles: CATALOG_MANIFEST.roles,
    rolePermissions: Object.fromEntries(
      Object.entries(CATALOG_MANIFEST.rolePermissions).map(([role, slugs]) => [role, slugs.filter((s) => s !== slug)]),
    ),
  };
}

/** The shipped manifest with one grant removed from one role; the permission itself stays. */
function withoutGrant(role: string, slug: string): CatalogManifest {
  return {
    ...CATALOG_MANIFEST,
    rolePermissions: {
      ...CATALOG_MANIFEST.rolePermissions,
      [role]: (CATALOG_MANIFEST.rolePermissions[role] ?? []).filter((s) => s !== slug),
    },
  };
}

describe('catalog reconciler against Postgres', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    try {
      await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });
    } finally {
      // A leaked pool keeps Jest alive; the restore must not be able to skip this.
      await db.close();
    }
  });

  const grantCount = (role: string, slug: string) =>
    db.client.rolePermission.count({ where: { role: { name: role }, permission: { slug } } });

  it('finds the seeded database already converged: every row System-owned and nothing to write', async () => {
    const result = await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });

    expect(result.mutations).toBe(0);
    expect(result.plan.permissions.skipped).toEqual([]);
    expect(result.plan.permissions.retained).toEqual([]);
    expect(result.plan.roles.orphans).toEqual([]);

    const notSystem = { where: { managedBy: { not: PermissionOwner.System } } };
    expect(await db.client.permission.count(notSystem)).toBe(0);
    expect(await db.client.role.count(notSystem)).toBe(0);
    expect(await db.client.rolePermission.count(notSystem)).toBe(0);
    expect(await db.client.permission.count({ where: { retiredAt: { not: null } } })).toBe(0);
  });

  it('revokes a grant the manifest drops, logs the write, and restores it when the manifest lists it again', async () => {
    expect(await grantCount(SystemRole.User, 'read:game')).toBe(1);
    const logged: string[] = [];

    const dropped = await reconcileCatalog(db.client, withoutGrant(SystemRole.User, 'read:game'), {
      logger: { log: (message: string) => void logged.push(message), warn: () => undefined },
    });

    expect(dropped.mutations).toBe(1);
    expect(logged).toEqual([
      'Catalog reconcile: permissions +0 ~0 revived 0 retired 0; roles +0 ~0; grants +0 -1',
      `grant 'User → read:game' revoked`,
    ]);
    expect(dropped.plan.rolePermissions.delete).toEqual([{ roleName: 'User', permissionSlug: 'read:game' }]);
    expect(await grantCount(SystemRole.User, 'read:game')).toBe(0);

    const restored = await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });

    expect(restored.plan.rolePermissions.create).toEqual([{ roleName: 'User', permissionSlug: 'read:game' }]);
    expect(await grantCount(SystemRole.User, 'read:game')).toBe(1);
  });

  it('retires a permission the manifest drops, then revives the SAME row and its grants when it returns', async () => {
    const slug = 'read:audit_log';
    const { id } = await db.client.permission.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const grantsBefore = await db.client.rolePermission.count({ where: { permission: { slug } } });
    expect(grantsBefore).toBeGreaterThan(0);

    const dropped = await reconcileCatalog(db.client, without(slug), { logger: silent });

    expect(dropped.plan.permissions.retire).toEqual([slug]);
    expect(dropped.plan.rolePermissions.delete).toHaveLength(grantsBefore);
    const retired = await db.client.permission.findUniqueOrThrow({ where: { slug } });
    expect(retired.id).toBe(id);
    expect(retired.retiredAt).not.toBeNull();
    expect(await db.client.rolePermission.count({ where: { permission: { slug } } })).toBe(0);

    const restored = await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });

    expect(restored.plan.permissions.create).toEqual([]);
    expect(restored.plan.permissions.revive).toEqual([slug]);
    const revived = await db.client.permission.findUniqueOrThrow({ where: { slug } });
    expect(revived.id).toBe(id);
    expect(revived.retiredAt).toBeNull();
    expect(await db.client.rolePermission.count({ where: { permission: { slug } } })).toBe(grantsBefore);
  });

  it("keeps an operator's override and reports it, and converges the row only once it is handed back", async () => {
    const slug = 'read:game';
    await db.client.permission.update({
      where: { slug },
      data: { managedBy: PermissionOwner.Admin, riskLevel: RiskLevel.Critical },
    });

    try {
      const result = await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });

      expect(result.mutations).toBe(0);
      expect(result.plan.permissions.skipped).toEqual([
        {
          slug,
          managedBy: PermissionOwner.Admin,
          drift: [{ field: 'riskLevel', from: RiskLevel.Critical, to: RiskLevel.Low }],
        },
      ]);
      expect((await db.client.permission.findUniqueOrThrow({ where: { slug } })).riskLevel).toBe(RiskLevel.Critical);
    } finally {
      await db.client.permission.update({ where: { slug }, data: { managedBy: PermissionOwner.System } });
    }

    const converged = await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });

    expect(converged.plan.permissions.update).toEqual([
      { slug, changes: [{ field: 'riskLevel', from: RiskLevel.Critical, to: RiskLevel.Low }] },
    ]);
    expect((await db.client.permission.findUniqueOrThrow({ where: { slug } })).riskLevel).toBe(RiskLevel.Low);
  });

  it('refuses a manifest that claims a Plugin-owned row, and writes nothing at all', async () => {
    await db.client.permission.update({ where: { slug: 'read:game' }, data: { managedBy: PermissionOwner.Plugin } });
    expect(await grantCount(SystemRole.User, 'create:household')).toBe(1);

    try {
      // The same manifest also drops a grant: were the refusal not whole, that grant would be gone.
      const attempt = reconcileCatalog(db.client, withoutGrant(SystemRole.User, 'create:household'), {
        logger: silent,
      });

      await expect(attempt).rejects.toBeInstanceOf(CatalogReconcileConflictError);
      await expect(attempt).rejects.toThrow(/permission 'read:game' is Plugin-owned/);
      expect(await grantCount(SystemRole.User, 'create:household')).toBe(1);
    } finally {
      await db.client.permission.update({ where: { slug: 'read:game' }, data: { managedBy: PermissionOwner.System } });
    }
  });

  it('hands the applied plan to the invalidation port once, and not at all when nothing was written', async () => {
    const calls: ReconcilePlan[] = [];
    const invalidate = async (plan: ReconcilePlan): Promise<void> => {
      calls.push(plan);
    };

    await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent, invalidate });
    expect(calls).toEqual([]);

    await reconcileCatalog(db.client, withoutGrant(SystemRole.User, 'read:game'), { logger: silent, invalidate });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rolePermissions.delete).toEqual([{ roleName: 'User', permissionSlug: 'read:game' }]);

    await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });
  });

  it('reports a failing port instead of failing the reconcile, since the writes are already committed', async () => {
    const warnings: string[] = [];
    const logger = { log: () => undefined, warn: (message: string) => void warnings.push(message) };

    const result = await reconcileCatalog(db.client, withoutGrant(SystemRole.User, 'read:game'), {
      logger,
      invalidate: async () => {
        throw new Error('redis down');
      },
    });

    expect(result.mutations).toBe(1);
    expect(result.invalidated).toBe(false);
    expect(warnings).toEqual([expect.stringContaining('redis down')]);
    expect(await grantCount(SystemRole.User, 'read:game')).toBe(0);

    const restored = await reconcileCatalog(db.client, CATALOG_MANIFEST, {
      logger: silent,
      invalidate: async () => undefined,
    });
    expect(restored.invalidated).toBe(true);
  });

  it('says so when it wrote rows without a port to invalidate through', async () => {
    const warnings: string[] = [];
    const logger = { log: () => undefined, warn: (message: string) => void warnings.push(message) };

    await reconcileCatalog(db.client, withoutGrant(SystemRole.User, 'read:game'), { logger });

    expect(warnings).toEqual([expect.stringContaining('not touched')]);

    await reconcileCatalog(db.client, CATALOG_MANIFEST, { logger: silent });
  });
});
