import { SystemRole } from '../client';
import { PERMISSION_CATALOG } from './permission.catalog';
import { ROLE_PERMISSION_CATALOG } from './role-permission.catalog';
import { ROLE_CATALOG, ROLE_SCOPE } from './role.catalog';

// Importing the catalog modules IS the positive integrity case: each runs its
// assertions at module scope, so a shipped catalog that violated one would fail
// this file at import. The negative cases live in catalog-integrity.spec.ts.
describe('the shipped catalogs', () => {
  it('seed every SystemRole exactly once, and assign and classify every one of them', () => {
    const systemRoles = Object.values(SystemRole).sort();

    expect(ROLE_CATALOG.map((role) => role.name).sort()).toEqual(systemRoles);
    expect(Object.keys(ROLE_PERMISSION_CATALOG).sort()).toEqual(systemRoles);
    expect(Object.keys(ROLE_SCOPE).sort()).toEqual(systemRoles);
  });

  it('classify the household and event roles as scoped, everything else as global', () => {
    const scoped = Object.entries(ROLE_SCOPE)
      .filter(([, scope]) => scope !== 'global')
      .map(([role]) => role)
      .sort();

    expect(scoped).toEqual(
      [
        SystemRole.HouseholdOwner,
        SystemRole.HouseholdAdmin,
        SystemRole.HouseholdMember,
        SystemRole.HouseholdGuest,
        SystemRole.EventHost,
        SystemRole.EventCoHost,
        SystemRole.EventOrganizer,
        SystemRole.EventModerator,
        SystemRole.EventParticipant,
        SystemRole.EventGuest,
        SystemRole.EventSpectator,
      ].sort(),
    );
  });

  describe('derived role lists', () => {
    it('grant Owner exactly the wildcard', () => {
      expect(ROLE_PERMISSION_CATALOG[SystemRole.Owner]).toEqual(['manage:all']);
    });

    it('grant Admin every slug except the wildcard', () => {
      const admin = ROLE_PERMISSION_CATALOG[SystemRole.Admin];

      expect(admin).not.toContain('manage:all');
      expect(admin).toHaveLength(PERMISSION_CATALOG.length - 1);
    });

    it('derive HouseholdAdmin from HouseholdOwner minus deletion and the ownership-transfer gate', () => {
      const owner = ROLE_PERMISSION_CATALOG[SystemRole.HouseholdOwner];
      const admin = ROLE_PERMISSION_CATALOG[SystemRole.HouseholdAdmin];

      expect(admin).not.toContain('delete:household');
      expect(admin).not.toContain('update:household_role:transfer-ownership');
      expect(owner.filter((slug) => !admin.includes(slug))).toEqual([
        'delete:household',
        'update:household_role:transfer-ownership',
      ]);
    });

    it('derive EventCoHost from EventHost minus event deletion only', () => {
      const host = ROLE_PERMISSION_CATALOG[SystemRole.EventHost];
      const coHost = ROLE_PERMISSION_CATALOG[SystemRole.EventCoHost];

      expect(host.filter((slug) => !coHost.includes(slug))).toEqual(['delete:event']);
    });
  });
});
