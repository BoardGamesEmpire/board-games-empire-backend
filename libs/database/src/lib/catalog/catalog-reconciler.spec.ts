import { Action, PermissionOwner, ResourceType, RiskLevel, SystemRole } from '../client';
import type { ReconcilePlan } from './catalog-reconcile-plan';
import { describeConflicts, describeDrift, describeWrites, summarizePlan } from './catalog-reconciler';

// The apply itself runs only against Postgres (apps/api-e2e/src/database/
// catalog-reconcile.spec.ts). What is pure here is what the reconcile SAYS:
// the one-line summary, the drift report and the conflict sentences.

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
