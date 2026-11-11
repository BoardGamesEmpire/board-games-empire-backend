import { Action, PermissionOwner, ResourceType, RiskLevel, SystemRole } from '../client';
import type { EntryProblem } from './catalog-entry-check';
import type {
  CatalogManifest,
  CatalogSnapshot,
  FailingEntries,
  PermissionSnapshotRow,
  RolePermissionSnapshotRow,
  RoleSnapshotRow,
} from './catalog-reconcile-plan';
import { countMutations, edgeKey, planReconcile, reconcileCounts } from './catalog-reconcile-plan';
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
      retireEdited: [],
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
      { slug: 'read:game', managedBy: PermissionOwner.Admin, retiredAt: null },
      { slug: 'read:job', managedBy: PermissionOwner.Plugin, retiredAt: null },
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
  revokedAt: null,
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

  it("removes an orphan System role's System grants: the row is kept, the grants follow the grant rule", () => {
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

  it('deletes a System edge the manifest no longer lists — removing a slug from the role removes the grant', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game'] } }),
      snapshot({ rolePermissions: [edgeRow(), edgeRow({ permissionSlug: 'delete:game' })] }),
    );

    expect(plan.rolePermissions.delete).toEqual([{ roleName: SystemRole.User, permissionSlug: 'delete:game' }]);
    expect(plan.rolePermissions.create).toEqual([]);
  });

  it('restores a revoked System grant the catalog lists (#772)', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game'] } }),
      snapshot({ rolePermissions: [edgeRow({ revokedAt: new Date('2026-11-01T00:00:00Z') })] }),
    );

    expect(plan.rolePermissions.restore).toEqual([{ roleName: 'User', permissionSlug: 'read:game' }]);
    expect(plan.rolePermissions.create).toEqual([]);
    expect(plan.rolePermissions.delete).toEqual([]);
    expect(countMutations(plan)).toBe(1);
    expect(reconcileCounts(plan).grantsRestored).toBe(1);
  });

  it('keeps a revoked Admin grant the catalog lists and reports it (#772)', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game'] } }),
      snapshot({
        rolePermissions: [edgeRow({ managedBy: PermissionOwner.Admin, revokedAt: new Date('2026-11-01T00:00:00Z') })],
      }),
    );

    expect(plan.rolePermissions.restore).toEqual([]);
    expect(plan.rolePermissions.skipped).toEqual([{ roleName: 'User', permissionSlug: 'read:game' }]);
    expect(countMutations(plan)).toBe(0);
  });

  it('deletes an unlisted System grant whether or not it is revoked (#772)', () => {
    const plan = planReconcile(
      manifest(),
      snapshot({
        rolePermissions: [
          edgeRow({ permissionSlug: 'read:game' }),
          edgeRow({ permissionSlug: 'read:job', revokedAt: new Date('2026-11-01T00:00:00Z') }),
        ],
      }),
    );

    expect(plan.rolePermissions.delete).toEqual([
      { roleName: 'User', permissionSlug: 'read:game' },
      { roleName: 'User', permissionSlug: 'read:job' },
    ]);
    expect(plan.rolePermissions.restore).toEqual([]);
  });

  it('has nothing to converge for a listed edge that already exists, whoever owns it', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game', 'read:job'] } }),
      snapshot({
        rolePermissions: [edgeRow(), edgeRow({ permissionSlug: 'read:job', managedBy: PermissionOwner.Admin })],
      }),
    );

    expect(plan.rolePermissions).toEqual({
      create: [],
      restore: [],
      delete: [],
      revokeEdited: [],
      withheld: [],
      skipped: [],
      retained: [],
      conflicts: [],
    });
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
      { roleName: SystemRole.User, permissionSlug: 'delete:game', managedBy: PermissionOwner.Admin, revokedAt: null },
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
    expect(plan.permissions.retained).toEqual([
      { slug: 'read:quota', managedBy: PermissionOwner.Admin, retiredAt: null },
    ]);
  });

  it('reports the writes by table as counts, with the mutation total, for the boot summary', () => {
    const plan = planReconcile(
      manifest({
        permissions: [definition({ slug: 'read:game' }), definition({ slug: 'read:job', riskLevel: RiskLevel.High })],
        roles: [roleDefinition()],
        rolePermissions: { [SystemRole.User]: ['read:game'] },
      }),
      snapshot({
        permissions: [
          row({ slug: 'read:job', retiredAt: new Date('2026-09-01T00:00:00Z') }),
          row({ slug: 'read:quota' }),
        ],
        roles: [],
        rolePermissions: [],
      }),
    );

    // read:game created; read:job revived AND drifted (one write, counted in
    // both columns as the summary line prints them); read:quota retired.
    expect(reconcileCounts(plan)).toEqual({
      permissionsCreated: 1,
      permissionsUpdated: 1,
      permissionsRevived: 1,
      permissionsRetired: 1,
      permissionsRetiredAfterCheck: 0,
      rolesCreated: 1,
      rolesUpdated: 0,
      grantsCreated: 1,
      grantsRestored: 0,
      grantsRemoved: 0,
      grantsRevokedAfterCheck: 0,
      mutations: 5,
    });
  });
});

describe('planReconcile — an edited entry that fails its check (#772)', () => {
  // `findFailingEditedEntries` decides which entries fail; the planner decides
  // which of those it writes, from the snapshot alone: an Owner's entry that
  // still confers something. The edit itself is never touched, so the Owner
  // can fix it and hand it back.

  const rejected: EntryProblem = {
    kind: 'query-rejected',
    slug: 'read:game',
    message: 'Unknown argument `visibility`. Available options are marked with ?.',
  };
  const failsOpen: EntryProblem = { kind: 'fails-open', slug: 'read:audit_log', role: SystemRole.HouseholdGuest };

  const failing = (overrides: Partial<FailingEntries> = {}): FailingEntries => ({
    permissions: new Map(),
    grants: new Map(),
    withheld: new Map(),
    ...overrides,
  });

  it('withholds a shipped grant the check failed: neither created nor restored, and not a write (#772)', () => {
    const withheld = { kind: 'fails-open', slug: 'read:game', role: SystemRole.HouseholdMember } as const;
    const restoring = { kind: 'fails-open', slug: 'read:job', role: SystemRole.HouseholdMember } as const;

    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.HouseholdMember]: ['read:game', 'read:job', 'read:game_share:own'] } }),
      snapshot({
        rolePermissions: [
          edgeRow({ roleName: SystemRole.HouseholdMember, permissionSlug: 'read:job', revokedAt: new Date() }),
        ],
      }),
      failing({
        withheld: new Map([
          [edgeKey(SystemRole.HouseholdMember, 'read:game'), [withheld]],
          [edgeKey(SystemRole.HouseholdMember, 'read:job'), [restoring]],
        ]),
      }),
    );

    expect(plan.rolePermissions.create).toEqual([
      { roleName: SystemRole.HouseholdMember, permissionSlug: 'read:game_share:own' },
    ]);
    expect(plan.rolePermissions.restore).toEqual([]);
    expect(plan.rolePermissions.withheld).toEqual([
      { roleName: SystemRole.HouseholdMember, permissionSlug: 'read:game', problems: [withheld] },
      { roleName: SystemRole.HouseholdMember, permissionSlug: 'read:job', problems: [restoring] },
    ]);
    expect(countMutations(plan)).toBe(1);
  });

  it('retires an Admin permission the check failed, and keeps it Admin', () => {
    const edited = row({ slug: 'read:game', conditions: { visibility: 'Public' }, managedBy: PermissionOwner.Admin });
    const unlisted = row({ slug: 'read:audit_log', managedBy: PermissionOwner.Admin });

    const plan = planReconcile(
      manifest({ permissions: [definition({ slug: 'read:game' })] }),
      snapshot({ permissions: [edited, unlisted] }),
      failing({ permissions: new Map([['read:game', [rejected]]]) }),
    );

    expect(plan.permissions.retireEdited).toEqual([{ slug: 'read:game', problems: [rejected] }]);
    // The Owner's edit is neither converged nor handed to the System retire;
    // its drift is still reported, as for any Owner's entry.
    expect(plan.permissions.update).toEqual([]);
    expect(plan.permissions.retire).toEqual([]);
    expect(plan.permissions.skipped).toEqual([
      {
        slug: 'read:game',
        managedBy: PermissionOwner.Admin,
        drift: [{ field: 'conditions', from: { visibility: 'Public' }, to: {} }],
      },
    ]);
    expect(plan.permissions.retained).toEqual([
      { slug: 'read:audit_log', managedBy: PermissionOwner.Admin, retiredAt: null },
    ]);
    expect(countMutations(plan)).toBe(1);
    expect(reconcileCounts(plan)).toMatchObject({ permissionsRetired: 0, permissionsRetiredAfterCheck: 1 });

    // An Owner's permission the catalog does not list is judged the same way.
    const retainedFails = planReconcile(
      manifest(),
      snapshot({ permissions: [unlisted] }),
      failing({ permissions: new Map([['read:audit_log', [failsOpen]]]) }),
    );
    expect(retainedFails.permissions.retireEdited).toEqual([{ slug: 'read:audit_log', problems: [failsOpen] }]);
  });

  it('revokes an Admin grant the check failed', () => {
    const plan = planReconcile(
      manifest({ rolePermissions: { [SystemRole.User]: ['read:game'] } }),
      snapshot({
        rolePermissions: [
          edgeRow({ managedBy: PermissionOwner.Admin }),
          edgeRow({
            roleName: SystemRole.HouseholdGuest,
            permissionSlug: 'read:audit_log',
            managedBy: PermissionOwner.Admin,
          }),
          edgeRow({ roleName: SystemRole.Moderator, managedBy: PermissionOwner.Admin }),
        ],
      }),
      failing({
        grants: new Map([
          [edgeKey(SystemRole.User, 'read:game'), [rejected]],
          [edgeKey(SystemRole.HouseholdGuest, 'read:audit_log'), [failsOpen]],
        ]),
      }),
    );

    // A listed grant and one the Owner added are revoked alike; the passing one is not.
    expect(plan.rolePermissions.revokeEdited).toEqual([
      { roleName: SystemRole.User, permissionSlug: 'read:game', problems: [rejected] },
      { roleName: SystemRole.HouseholdGuest, permissionSlug: 'read:audit_log', problems: [failsOpen] },
    ]);
    expect(plan.rolePermissions.delete).toEqual([]);
    expect(plan.rolePermissions.retained).toHaveLength(2);
    expect(countMutations(plan)).toBe(2);
    expect(reconcileCounts(plan)).toMatchObject({ grantsRemoved: 0, grantsRevokedAfterCheck: 2 });
  });

  it('leaves an already-retired failing Admin permission alone', () => {
    // A second start finds the entry still failing, already fails closed, and
    // writes nothing; `findFailingEditedEntries` no longer names it, but the
    // planner does not rely on that.
    const retiredAt = new Date('2026-11-08T00:00:00Z');

    const plan = planReconcile(
      manifest({
        permissions: [definition({ slug: 'read:game' })],
        rolePermissions: { [SystemRole.User]: ['read:game'] },
      }),
      snapshot({
        permissions: [row({ slug: 'read:game', managedBy: PermissionOwner.Admin, retiredAt })],
        rolePermissions: [edgeRow({ managedBy: PermissionOwner.Admin, revokedAt: retiredAt })],
      }),
      failing({
        permissions: new Map([['read:game', [rejected]]]),
        grants: new Map([[edgeKey(SystemRole.User, 'read:game'), [rejected]]]),
      }),
    );

    expect(plan.permissions.retireEdited).toEqual([]);
    expect(plan.rolePermissions.revokeEdited).toEqual([]);
    expect(countMutations(plan)).toBe(0);
  });

  it('never retires or revokes an entry the server owns, whatever the failing list names', () => {
    const plan = planReconcile(
      manifest({
        permissions: [definition({ slug: 'read:game' })],
        rolePermissions: { [SystemRole.User]: ['read:game'] },
      }),
      snapshot({ permissions: [row({ slug: 'read:game' })], rolePermissions: [edgeRow()] }),
      failing({
        permissions: new Map([['read:game', [rejected]]]),
        grants: new Map([[edgeKey(SystemRole.User, 'read:game'), [rejected]]]),
      }),
    );

    expect(plan.permissions.retireEdited).toEqual([]);
    expect(plan.rolePermissions.revokeEdited).toEqual([]);
    expect(countMutations(plan)).toBe(0);
  });
});
