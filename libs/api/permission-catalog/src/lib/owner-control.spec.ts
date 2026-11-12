import {
  Action,
  CATALOG_MANIFEST,
  PermissionOwner,
  planReconcile,
  RiskLevel,
  SystemRole,
  type CatalogSnapshot,
  type PermissionSnapshotRow,
  type RolePermissionSnapshotRow,
} from '@bge/database';
import { HttpStatus } from '@nestjs/common';
import { OWNER_PERMISSION_SLUG, ownerKeepsControl, refuseOwnerLockout } from './owner-control';

const RETIRED = new Date('2026-11-08T00:00:00.000Z');

const permission = (slug: string, overrides: Partial<PermissionSnapshotRow> = {}): PermissionSnapshotRow => ({
  slug,
  action: Action.manage,
  subject: 'all',
  fields: [],
  conditions: {},
  inverted: false,
  reason: 'fixture',
  riskLevel: RiskLevel.Critical,
  managedBy: PermissionOwner.System,
  retiredAt: null,
  ...overrides,
});

const grant = (
  roleName: string,
  permissionSlug: string,
  overrides: Partial<RolePermissionSnapshotRow> = {},
): RolePermissionSnapshotRow => ({
  roleName,
  permissionSlug,
  managedBy: PermissionOwner.System,
  revokedAt: null,
  ...overrides,
});

/** The Owner holding `manage:all`, and a User grant beside it. */
const snapshot = (
  owner: Partial<PermissionSnapshotRow> = {},
  ownerGrant: Partial<RolePermissionSnapshotRow> = {},
): CatalogSnapshot => ({
  permissions: [permission(OWNER_PERMISSION_SLUG, owner), permission('read:game', { action: Action.read })],
  roles: [],
  rolePermissions: [grant(SystemRole.Owner, OWNER_PERMISSION_SLUG, ownerGrant), grant(SystemRole.User, 'read:game')],
});

describe('ownerKeepsControl (#772)', () => {
  it('holds while the Owner role has a live manage:all through a grant that is not revoked', () => {
    expect(ownerKeepsControl(snapshot())).toBe(true);
  });

  it('fails when manage:all is retired', () => {
    expect(ownerKeepsControl(snapshot({ retiredAt: RETIRED }))).toBe(false);
  });

  it("fails when the Owner role's grant of it is revoked, or gone", () => {
    expect(ownerKeepsControl(snapshot({}, { revokedAt: RETIRED }))).toBe(false);
    expect(ownerKeepsControl({ ...snapshot(), rolePermissions: [grant(SystemRole.User, 'read:game')] })).toBe(false);
  });

  it('fails when another role holds manage:all but the Owner role does not', () => {
    expect(
      ownerKeepsControl({ ...snapshot(), rolePermissions: [grant(SystemRole.Admin, OWNER_PERMISSION_SLUG)] }),
    ).toBe(false);
  });

  it('fails when manage:all is not in the permission catalog at all', () => {
    expect(ownerKeepsControl({ ...snapshot(), permissions: [permission('read:game')] })).toBe(false);
  });
});

describe('refuseOwnerLockout (#772)', () => {
  it('lets through a permission catalog that leaves the Owner in control', () => {
    expect(() => refuseOwnerLockout(snapshot())).not.toThrow();
  });

  it('refuses one that does not with 422 CATALOG_OWNER_LOCKOUT', () => {
    let thrown: unknown;
    try {
      refuseOwnerLockout(snapshot({ retiredAt: RETIRED }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      response: { statusCode: 422, error: 'Unprocessable Entity', code: 'CATALOG_OWNER_LOCKOUT' },
    });
  });
});

describe('a hand back and the Owner role (#772)', () => {
  it('needs no lockout check: the next start revives a handed-back manage:all and restores the Owner grant of it', () => {
    // A hand back changes only who manages the entry. What leaves the Owner
    // in control is that the permission catalog this version ships gives the
    // Owner role manage:all, so the next start converges both back.
    const handedBack = snapshot({ retiredAt: RETIRED }, { revokedAt: RETIRED });
    expect(ownerKeepsControl(handedBack)).toBe(false);

    const plan = planReconcile(CATALOG_MANIFEST, handedBack);

    expect(plan.permissions.revive).toContain(OWNER_PERMISSION_SLUG);
    expect(plan.rolePermissions.restore).toContainEqual({
      roleName: SystemRole.Owner,
      permissionSlug: OWNER_PERMISSION_SLUG,
    });
  });
});
