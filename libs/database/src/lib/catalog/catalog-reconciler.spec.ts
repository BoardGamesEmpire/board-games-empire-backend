import type { Prisma } from '../client';
import { Action, PermissionOwner, ResourceType, RiskLevel, SystemRole } from '../client';
import type { ReconcilePlan } from './catalog-reconcile-plan';
import {
  applyReconcilePlan,
  CATALOG_MANIFEST,
  CatalogReconcileShortWriteError,
  describeConflicts,
  describeDrift,
  describeWrites,
  summarizePlan,
} from './catalog-reconciler';

// The apply's writes run only against Postgres (apps/api-e2e/src/database/
// catalog-reconcile.spec.ts). What is pure here is what the reconcile SAYS —
// the one-line summary, the drift report and the conflict sentences — and
// what it does with a statement's row count, over a transaction that lies.

const emptyPlan = (): ReconcilePlan => ({
  permissions: { create: [], update: [], revive: [], retire: [], skipped: [], retained: [], conflicts: [] },
  roles: { create: [], update: [], skipped: [], orphans: [], conflicts: [] },
  rolePermissions: { create: [], delete: [], retained: [], conflicts: [] },
});

describe('what a reconcile says', () => {
  it('summarises the writes by table on one line', () => {
    const plan: ReconcilePlan = {
      ...emptyPlan(),
      permissions: {
        ...emptyPlan().permissions,
        create: [
          { action: Action.read, subject: ResourceType.Game, slug: 'read:game', riskLevel: RiskLevel.Low, reason: 'x' },
        ],
        revive: ['read:job'],
        retire: ['read:quota', 'read:media'],
      },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        delete: [{ roleName: SystemRole.User, permissionSlug: 'read:quota' }],
      },
    };

    expect(summarizePlan(plan)).toBe(
      'Catalog reconcile: permissions +1 ~0 revived 1 retired 2; roles +0 ~0; grants +0 -1',
    );
  });

  it('names every write that changes or removes authority, and leaves creates to the count', () => {
    const plan: ReconcilePlan = {
      ...emptyPlan(),
      permissions: {
        ...emptyPlan().permissions,
        create: [
          { action: Action.read, subject: ResourceType.Game, slug: 'read:game', riskLevel: RiskLevel.Low, reason: 'x' },
        ],
        update: [{ slug: 'read:job', changes: [{ field: 'riskLevel', from: RiskLevel.Low, to: RiskLevel.High }] }],
        revive: ['read:job'],
        retire: ['read:quota'],
      },
      roles: {
        ...emptyPlan().roles,
        create: [{ name: SystemRole.User, description: 'Standard user account' }],
        update: [{ name: SystemRole.Admin, changes: [{ field: 'description', from: 'Old', to: 'Full access' }] }],
      },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        create: [{ roleName: SystemRole.User, permissionSlug: 'read:game' }],
        delete: [{ roleName: SystemRole.Moderator, permissionSlug: 'read:quota' }],
      },
    };

    expect(describeWrites(plan)).toEqual([
      `permission 'read:job' updated: riskLevel "Low" → "High"`,
      `permission 'read:job' revived`,
      `permission 'read:quota' retired`,
      `role 'Admin' updated: description "Old" → "Full access"`,
      `grant 'Moderator → read:quota' revoked`,
    ]);
  });

  it('reports every row it left alone, with its owner and its drift', () => {
    const plan: ReconcilePlan = {
      ...emptyPlan(),
      permissions: {
        ...emptyPlan().permissions,
        skipped: [
          {
            slug: 'read:game',
            managedBy: PermissionOwner.Admin,
            drift: [{ field: 'riskLevel', from: RiskLevel.Critical, to: RiskLevel.Low }],
          },
          { slug: 'read:job', managedBy: PermissionOwner.Admin, drift: [] },
        ],
        retained: [{ slug: 'read:quota', managedBy: PermissionOwner.Plugin }],
      },
      roles: { ...emptyPlan().roles, orphans: ['Librarian'] },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        delete: [{ roleName: 'Librarian', permissionSlug: 'read:quota' }],
        retained: [{ roleName: 'Librarian', permissionSlug: 'read:game', managedBy: PermissionOwner.Admin }],
      },
    };

    expect(describeDrift(plan)).toEqual([
      `Admin-owned permission 'read:game' left alone; drift: riskLevel "Critical" → "Low"`,
      `Admin-owned permission 'read:job' left alone; no drift`,
      `Plugin-owned permission 'read:quota' is not in the manifest; retained`,
      `System-owned role 'Librarian' is not in the manifest; the row is kept, 1 of its System grants is revoked`,
      `Admin-owned grant 'Librarian → read:game' is not in the manifest; retained`,
    ]);
  });

  it('names each conflict so the refusal says what to fix', () => {
    const plan: ReconcilePlan = {
      ...emptyPlan(),
      permissions: { ...emptyPlan().permissions, conflicts: [{ slug: 'read:game' }] },
      roles: { ...emptyPlan().roles, conflicts: [{ name: 'User' }] },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        conflicts: [{ roleName: 'User', permissionSlug: 'read:game' }],
      },
    };

    expect(describeConflicts(plan)).toEqual([
      `permission 'read:game' is Plugin-owned but the manifest defines it`,
      `role 'User' is Plugin-owned but the manifest defines it`,
      `grant 'User → read:game' is Plugin-owned but the manifest lists it`,
    ]);
    expect(describeConflicts(emptyPlan())).toEqual([]);
  });
});

describe('applyReconcilePlan — a batch statement that writes fewer rows than planned', () => {
  // Under the boot lock (#236) the only way a `createMany`, `updateMany` or
  // `deleteMany` comes up short is a row another writer touched between the
  // snapshot and the write. The count is compared to the plan and the apply
  // throws, so the transaction rolls back and the log never names a write
  // that did not land.

  interface FakeTx {
    readonly calls: string[];
    readonly tx: Prisma.TransactionClient;
  }

  /** Every batch statement reports the rows it was asked for, less `short` for the one named. */
  function fakeTx(short: { readonly statement: string; readonly by: number } | undefined = undefined): FakeTx {
    const calls: string[] = [];
    const count = (statement: string, asked: number) => {
      calls.push(statement);
      return { count: short?.statement === statement ? asked - short.by : asked };
    };
    const ids = (rows: { slug?: string; name?: string }[]) => rows.map((row, i) => ({ ...row, id: `id-${i}` }));

    const tx = {
      permission: {
        createMany: async ({ data }: { data: unknown[] }) => count('permission.createMany', data.length),
        update: async () => void calls.push('permission.update'),
        updateMany: async ({ where }: { where: { slug: { in: string[] } } }) =>
          count('permission.updateMany', where.slug.in.length),
        findMany: async ({ where }: { where: { slug: { in: string[] } } }) =>
          ids(where.slug.in.map((slug) => ({ slug }))),
      },
      role: {
        createMany: async ({ data }: { data: unknown[] }) => count('role.createMany', data.length),
        update: async () => void calls.push('role.update'),
        findMany: async ({ where }: { where: { name: { in: string[] } } }) =>
          ids(where.name.in.map((name) => ({ name }))),
      },
      rolePermission: {
        deleteMany: async ({ where }: { where: { OR: unknown[] } }) =>
          count('rolePermission.deleteMany', where.OR.length),
        createMany: async ({ data }: { data: unknown[] }) => count('rolePermission.createMany', data.length),
      },
    } as unknown as Prisma.TransactionClient;

    return { calls, tx };
  }

  const plan: ReconcilePlan = {
    ...emptyPlan(),
    permissions: {
      ...emptyPlan().permissions,
      create: [
        { action: Action.read, subject: ResourceType.Game, slug: 'read:game', riskLevel: RiskLevel.Low, reason: 'x' },
      ],
      retire: ['read:quota', 'read:media'],
    },
    roles: { ...emptyPlan().roles, create: [{ name: SystemRole.User, description: 'Standard user account' }] },
    rolePermissions: {
      ...emptyPlan().rolePermissions,
      delete: [{ roleName: SystemRole.Moderator, permissionSlug: 'read:quota' }],
      create: [
        { roleName: SystemRole.User, permissionSlug: 'read:game' },
        { roleName: SystemRole.User, permissionSlug: 'read:media' },
      ],
    },
  };

  it('applies a plan whose every statement writes its planned count, in dependency order', async () => {
    const { calls, tx } = fakeTx();

    await applyReconcilePlan(tx, CATALOG_MANIFEST, plan);

    expect(calls).toEqual([
      'permission.createMany',
      'permission.updateMany',
      'role.createMany',
      'rolePermission.deleteMany',
      'rolePermission.createMany',
    ]);
  });

  it('throws naming the statement and both counts when the grants land short, and runs nothing after it', async () => {
    const { calls, tx } = fakeTx({ statement: 'rolePermission.createMany', by: 1 });

    const apply = applyReconcilePlan(tx, CATALOG_MANIFEST, plan);

    await expect(apply).rejects.toThrow(CatalogReconcileShortWriteError);
    await expect(apply).rejects.toThrow(/rolePermission\.createMany wrote 1 of 2 planned row/);
    expect(calls.at(-1)).toBe('rolePermission.createMany');
  });

  it('checks the retire and revoke statements the same way, before anything that follows them', async () => {
    const retire = fakeTx({ statement: 'permission.updateMany', by: 2 });
    await expect(applyReconcilePlan(retire.tx, CATALOG_MANIFEST, plan)).rejects.toThrow(
      /permission\.updateMany wrote 0 of 2 planned row/,
    );
    expect(retire.calls).toEqual(['permission.createMany', 'permission.updateMany']);

    const revoke = fakeTx({ statement: 'rolePermission.deleteMany', by: 1 });
    await expect(applyReconcilePlan(revoke.tx, CATALOG_MANIFEST, plan)).rejects.toThrow(
      /rolePermission\.deleteMany wrote 0 of 1 planned row/,
    );
    expect(revoke.calls).not.toContain('rolePermission.createMany');
  });
});
