import { Action, PermissionOwner, ResourceType, RiskLevel, SystemRole } from '../client';
import type {
  CatalogManifest,
  CatalogSnapshot,
  PermissionSnapshotRow,
  RolePermissionSnapshotRow,
  RoleSnapshotRow,
} from './catalog-reconcile-plan';
import { countMutations, planReconcile } from './catalog-reconcile-plan';
import type { PermissionSeedDefinition, RoleSeedDefinition } from './seed-definitions';

const definition = (overrides: Partial<PermissionSeedDefinition> & Pick<PermissionSeedDefinition, 'slug'>) =>
  ({
    action: Action.read,
    subject: ResourceType.Game,
    riskLevel: RiskLevel.Low,
    reason: 'fixture',
    ...overrides,
  }) satisfies PermissionSeedDefinition;

/** A database row as the seed would have written `definition({ slug })`. */
const row = (
  overrides: Partial<PermissionSnapshotRow> & Pick<PermissionSnapshotRow, 'slug'>,
): PermissionSnapshotRow => ({
  action: Action.read,
  subject: ResourceType.Game,
  fields: [],
  conditions: {},
  inverted: false,
  reason: 'fixture',
  riskLevel: RiskLevel.Low,
  managedBy: PermissionOwner.System,
  retiredAt: null,
  ...overrides,
});

const manifest = (overrides: Partial<CatalogManifest> = {}): CatalogManifest => ({
  permissions: [],
  roles: [],
  rolePermissions: {},
  ...overrides,
});

const snapshot = (overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot => ({
  permissions: [],
  roles: [],
  rolePermissions: [],
  ...overrides,
});

describe('planReconcile — the Permission table', () => {
  it('creates a permission the manifest has and the database lacks, as System', () => {
    const wanted = definition({ slug: 'read:game' });

    const plan = planReconcile(manifest({ permissions: [wanted] }), snapshot());

    expect(plan.permissions.create).toEqual([wanted]);
    expect(plan.permissions.update).toEqual([]);
    expect(plan.permissions.retire).toEqual([]);
  });

  it('updates a System-owned row to the manifest, naming each changed field with both values', () => {
    const wanted = definition({ slug: 'read:game', riskLevel: RiskLevel.High, reason: 'now high' });

    const plan = planReconcile(
      manifest({ permissions: [wanted] }),
      snapshot({ permissions: [row({ slug: 'read:game', riskLevel: RiskLevel.Low, reason: 'fixture' })] }),
    );

    expect(plan.permissions.create).toEqual([]);
    expect(plan.permissions.update).toEqual([
      {
        slug: 'read:game',
        changes: [
          { field: 'reason', from: 'fixture', to: 'now high' },
          { field: 'riskLevel', from: RiskLevel.Low, to: RiskLevel.High },
        ],
      },
    ]);
  });

  it('plans nothing for a System-owned row that already matches the manifest', () => {
    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game' })] }),
      snapshot({ permissions: [row({ slug: 'read:game' })] }),
    );

    expect(plan.permissions).toEqual({
      create: [],
      update: [],
      revive: [],
      retire: [],
      skipped: [],
      retained: [],
      conflicts: [],
    });
  });

  it('does not overwrite an Admin-owned row, and records its drift instead', () => {
    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game', riskLevel: RiskLevel.Low })] }),
      snapshot({
        permissions: [row({ slug: 'read:game', riskLevel: RiskLevel.Critical, managedBy: PermissionOwner.Admin })],
      }),
    );

    expect(plan.permissions.update).toEqual([]);
    expect(plan.permissions.skipped).toEqual([
      {
        slug: 'read:game',
        managedBy: PermissionOwner.Admin,
        drift: [{ field: 'riskLevel', from: RiskLevel.Critical, to: RiskLevel.Low }],
      },
    ]);
  });

  it('reports a Plugin-owned row whose slug the manifest claims as a conflict', () => {
    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game' })] }),
      snapshot({ permissions: [row({ slug: 'read:game', managedBy: PermissionOwner.Plugin })] }),
    );

    expect(plan.permissions.conflicts).toEqual([{ slug: 'read:game' }]);
    expect(plan.permissions.update).toEqual([]);
    expect(plan.permissions.skipped).toEqual([]);
  });

  it('retires a System-owned row the manifest no longer lists', () => {
    const plan = planReconcile(manifest(), snapshot({ permissions: [row({ slug: 'read:game' })] }));

    expect(plan.permissions.retire).toEqual(['read:game']);
  });

  it('leaves an already-retired System row out of the plan entirely', () => {
    const plan = planReconcile(
      manifest(),
      snapshot({ permissions: [row({ slug: 'read:game', retiredAt: new Date('2026-09-01T00:00:00Z') })] }),
    );

    expect(plan.permissions.retire).toEqual([]);
    expect(plan.permissions.retained).toEqual([]);
  });

  it('retains an absent row that is not System-owned, naming its owner', () => {
    const plan = planReconcile(
      manifest(),
      snapshot({
        permissions: [
          row({ slug: 'read:game', managedBy: PermissionOwner.Admin }),
          row({ slug: 'read:job', managedBy: PermissionOwner.Plugin }),
        ],
      }),
    );

    expect(plan.permissions.retire).toEqual([]);
    expect(plan.permissions.retained).toEqual([
      { slug: 'read:game', managedBy: PermissionOwner.Admin },
      { slug: 'read:job', managedBy: PermissionOwner.Plugin },
    ]);
  });

  it('converges a System row whose inverted flag was flipped, since the catalog declares can rules only', () => {
    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game' })] }),
      snapshot({ permissions: [row({ slug: 'read:game', inverted: true })] }),
    );

    expect(plan.permissions.update).toEqual([
      { slug: 'read:game', changes: [{ field: 'inverted', from: true, to: false }] },
    ]);
  });

  it('reports a retired Admin-owned row the manifest lists as drift, since only a System row is revived', () => {
    const retiredAt = new Date('2026-09-01T00:00:00Z');

    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game' })] }),
      snapshot({ permissions: [row({ slug: 'read:game', managedBy: PermissionOwner.Admin, retiredAt })] }),
    );

    expect(plan.permissions.revive).toEqual([]);
    expect(plan.permissions.skipped).toEqual([
      {
        slug: 'read:game',
        managedBy: PermissionOwner.Admin,
        drift: [{ field: 'retiredAt', from: retiredAt, to: null }],
      },
    ]);
  });

  it('revives a retired System row whose slug is back in the manifest, and still converges its fields', () => {
    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game', riskLevel: RiskLevel.Medium })] }),
      snapshot({
        permissions: [
          row({ slug: 'read:game', retiredAt: new Date('2026-09-01T00:00:00Z'), riskLevel: RiskLevel.Low }),
        ],
      }),
    );

    expect(plan.permissions.create).toEqual([]);
    expect(plan.permissions.revive).toEqual(['read:game']);
    expect(plan.permissions.update).toEqual([
      { slug: 'read:game', changes: [{ field: 'riskLevel', from: RiskLevel.Low, to: RiskLevel.Medium }] },
    ]);
  });
});

const roleDefinition = (overrides: Partial<RoleSeedDefinition> = {}): RoleSeedDefinition => ({
  name: SystemRole.User,
  description: 'Standard user account',
  ...overrides,
});

const roleRow = (overrides: Partial<RoleSnapshotRow> = {}): RoleSnapshotRow => ({
  name: SystemRole.User,
  description: 'Standard user account',
  managedBy: PermissionOwner.System,
  ...overrides,
});

const edgeRow = (overrides: Partial<RolePermissionSnapshotRow> = {}): RolePermissionSnapshotRow => ({
  roleName: SystemRole.User,
  permissionSlug: 'read:game',
  managedBy: PermissionOwner.System,
  ...overrides,
});

describe('planReconcile — the Role table', () => {
  it('creates a manifest role the database lacks', () => {
    const wanted = roleDefinition();

    const plan = planReconcile(manifest({ roles: [wanted] }), snapshot());

    expect(plan.roles.create).toEqual([wanted]);
  });

  it("converges a System role's description and plans nothing when it already matches", () => {
    const drifted = planReconcile(
      manifest({ roles: [roleDefinition({ description: 'Standard account' })] }),
      snapshot({ roles: [roleRow({ description: 'Standard user account' })] }),
    );
    const matching = planReconcile(manifest({ roles: [roleDefinition()] }), snapshot({ roles: [roleRow()] }));

    expect(drifted.roles.update).toEqual([
      {
        name: SystemRole.User,
        changes: [{ field: 'description', from: 'Standard user account', to: 'Standard account' }],
      },
    ]);
    expect(matching.roles).toEqual({ create: [], update: [], skipped: [], orphans: [], conflicts: [] });
  });

  it('leaves an Admin-owned role alone and reports its drift; a Plugin-owned one is a conflict', () => {
    const plan = planReconcile(
      manifest({ roles: [roleDefinition(), roleDefinition({ name: SystemRole.Admin, description: 'Full access' })] }),
      snapshot({
        roles: [
          roleRow({ description: 'Renamed by an operator', managedBy: PermissionOwner.Admin }),
          roleRow({ name: SystemRole.Admin, description: 'Full access', managedBy: PermissionOwner.Plugin }),
        ],
      }),
    );

    expect(plan.roles.update).toEqual([]);
    expect(plan.roles.skipped).toEqual([
      {
        name: SystemRole.User,
        managedBy: PermissionOwner.Admin,
        drift: [{ field: 'description', from: 'Renamed by an operator', to: 'Standard user account' }],
      },
    ]);
    expect(plan.roles.conflicts).toEqual([{ name: SystemRole.Admin }]);
  });

  it('reports a System role the manifest no longer lists as an orphan and never plans a write to the row', () => {
    const plan = planReconcile(
      manifest(),
      snapshot({
        roles: [roleRow(), roleRow({ name: 'Librarian', managedBy: PermissionOwner.Admin })],
      }),
    );

    // The Admin-owned custom role is not reported: it is expected to be there.
    expect(plan.roles.orphans).toEqual([SystemRole.User]);
    expect(countMutations(plan)).toBe(0);
  });

  it("revokes an orphan System role's System grants: the row is kept, the grants follow the grant rule", () => {
    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game' })] }),
      snapshot({ permissions: [row({ slug: 'read:game' })], roles: [roleRow()], rolePermissions: [edgeRow()] }),
    );

    expect(plan.roles.orphans).toEqual(['User']);
    expect(plan.roles.update).toEqual([]);
    expect(plan.rolePermissions.delete).toEqual([{ roleName: 'User', permissionSlug: 'read:game' }]);
  });
});

describe('planReconcile — the RolePermission table', () => {
  it('creates the edge a manifest role lists and the database lacks', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game', 'read:job'] } }),
      snapshot({ rolePermissions: [edgeRow({ permissionSlug: 'read:game' })] }),
    );

    expect(plan.rolePermissions.create).toEqual([{ roleName: SystemRole.User, permissionSlug: 'read:job' }]);
    expect(plan.rolePermissions.delete).toEqual([]);
  });

  it('deletes a System edge the manifest no longer lists — removing a slug from the role revokes it', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game'] } }),
      snapshot({ rolePermissions: [edgeRow(), edgeRow({ permissionSlug: 'delete:game' })] }),
    );

    expect(plan.rolePermissions.delete).toEqual([{ roleName: SystemRole.User, permissionSlug: 'delete:game' }]);
    expect(plan.rolePermissions.create).toEqual([]);
  });

  it('has nothing to converge for a listed edge that already exists, whoever owns it', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game', 'read:job'] } }),
      snapshot({
        rolePermissions: [edgeRow(), edgeRow({ permissionSlug: 'read:job', managedBy: PermissionOwner.Admin })],
      }),
    );

    expect(plan.rolePermissions).toEqual({ create: [], delete: [], retained: [], conflicts: [] });
  });

  it('retains an absent edge it does not own, and treats a Plugin-owned listed edge as a conflict', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game'] } }),
      snapshot({
        rolePermissions: [
          edgeRow({ managedBy: PermissionOwner.Plugin }),
          edgeRow({ permissionSlug: 'delete:game', managedBy: PermissionOwner.Admin }),
        ],
      }),
    );

    expect(plan.rolePermissions.conflicts).toEqual([{ roleName: SystemRole.User, permissionSlug: 'read:game' }]);
    expect(plan.rolePermissions.retained).toEqual([
      { roleName: SystemRole.User, permissionSlug: 'delete:game', managedBy: PermissionOwner.Admin },
    ]);
    expect(plan.rolePermissions.delete).toEqual([]);
  });
});

describe('planReconcile — normalisation and the mutation count', () => {
  it('treats fields as a set and an absent conditions member as the {} the seed writes', () => {
    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game', fields: ['title', 'id'] })] }),
      snapshot({ permissions: [row({ slug: 'read:game', fields: ['id', 'title'], conditions: {} })] }),
    );

    expect(plan.permissions.update).toEqual([]);
  });

  it('ignores object key order in conditions but not a changed value, reporting both raw values', () => {
    const reordered = planReconcile(
      manifest({
        permissions: [definition({ slug: 'read:game', conditions: { ownerId: '{{ user.id }}', deletedAt: null } })],
      }),
      snapshot({
        permissions: [row({ slug: 'read:game', conditions: { deletedAt: null, ownerId: '{{ user.id }}' } })],
      }),
    );
    const changed = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game', conditions: { ownerId: '{{ user.id }}' } })] }),
      snapshot({ permissions: [row({ slug: 'read:game', conditions: { ownerId: '{{ householdId }}' } })] }),
    );

    expect(reordered.permissions.update).toEqual([]);
    expect(changed.permissions.update).toEqual([
      {
        slug: 'read:game',
        changes: [{ field: 'conditions', from: { ownerId: '{{ householdId }}' }, to: { ownerId: '{{ user.id }}' } }],
      },
    ]);
  });

  it('counts only the rows an apply writes: a revived-and-drifted permission is one', () => {
    const plan = planReconcile(
      manifest({
        permissions: [definition({ slug: 'read:game' }), definition({ slug: 'read:job', riskLevel: RiskLevel.High })],
        roles: [roleDefinition()],
        rolePermissions: { [SystemRole.User]: ['read:game'] },
      }),
      snapshot({
        permissions: [
          row({ slug: 'read:job', retiredAt: new Date('2026-09-01T00:00:00Z') }),
          row({ slug: 'read:quota', managedBy: PermissionOwner.Admin }),
        ],
        roles: [roleRow({ name: 'Librarian', managedBy: PermissionOwner.Admin })],
        rolePermissions: [
          edgeRow({ roleName: 'Librarian', permissionSlug: 'read:quota', managedBy: PermissionOwner.Admin }),
        ],
      }),
    );

    // read:game created; read:job revived AND updated (riskLevel) in one write; User role
    // created; User→read:game edge created. read:quota and the Librarian edge are retained.
    expect(countMutations(plan)).toBe(4);
    expect(plan.permissions.retained).toEqual([{ slug: 'read:quota', managedBy: PermissionOwner.Admin }]);
  });
});
