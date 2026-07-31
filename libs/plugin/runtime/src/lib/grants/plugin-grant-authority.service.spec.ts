import { DatabaseService, SystemRole, type HouseholdMember, type HouseholdPlugin, type UserRole } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { PluginGrantAuthorityService } from './plugin-grant-authority.service';

describe('PluginGrantAuthorityService', () => {
  let db: MockDatabaseService;
  let service: PluginGrantAuthorityService;

  beforeEach(() => {
    db = createMockDatabaseService();
    service = new PluginGrantAuthorityService(db as unknown as DatabaseService);
  });

  describe('isServerAdmin', () => {
    it('matches a UserRole assignment to Owner or Admin', async () => {
      db.userRole.findFirst.mockResolvedValue({ id: 'ur_1' } as UserRole);

      await expect(service.isServerAdmin('user-1')).resolves.toBe(true);
      expect(db.userRole.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-1', role: { name: { in: [SystemRole.Owner, SystemRole.Admin] } } },
        select: { id: true },
      });
    });

    it('is false without a matching assignment', async () => {
      db.userRole.findFirst.mockResolvedValue(null);

      await expect(service.isServerAdmin('user-1')).resolves.toBe(false);
    });
  });

  describe('isHouseholdAdmin', () => {
    it('requires an owner/admin MEMBERSHIP in the anchoring household', async () => {
      db.householdMember.findFirst.mockResolvedValue({ id: 'hm_1' } as HouseholdMember);

      await expect(service.isHouseholdAdmin('user-1', 'hh_1')).resolves.toBe(true);
      expect(db.householdMember.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          householdId: 'hh_1',
          role: { role: { name: { in: [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin] } } },
        },
        select: { id: true },
      });
    });

    it('is false for a plain member', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);

      await expect(service.isHouseholdAdmin('user-1', 'hh_1')).resolves.toBe(false);
    });
  });

  describe('hasQualifyingHouseholdForPlugin (household-agnostic user grants)', () => {
    it('is true when any membership household has the plugin ENABLED and not consent-suspended', async () => {
      db.householdMember.findMany.mockResolvedValue([
        { householdId: 'hh_1' },
        { householdId: 'hh_2' },
      ] as HouseholdMember[]);
      db.householdPlugin.findFirst.mockResolvedValue({ id: 'hp_1' } as HouseholdPlugin);

      await expect(service.hasQualifyingHouseholdForPlugin('user-1', 'plg_1')).resolves.toBe(true);
      // The serving predicate in full (#59 C3): a unit suspended pending
      // consent is not running the plugin, so it cannot anchor a user-scope
      // decision about it.
      expect(db.householdPlugin.findFirst).toHaveBeenCalledWith({
        where: {
          pluginId: 'plg_1',
          enabled: true,
          suspendedForConsent: false,
          householdId: { in: ['hh_1', 'hh_2'] },
        },
        select: { id: true },
      });
    });

    it('short-circuits false with no memberships at all', async () => {
      db.householdMember.findMany.mockResolvedValue([]);

      await expect(service.hasQualifyingHouseholdForPlugin('user-1', 'plg_1')).resolves.toBe(false);
      expect(db.householdPlugin.findFirst).not.toHaveBeenCalled();
    });

    it('is false when memberships exist but none has the plugin enabled and unsuspended', async () => {
      db.householdMember.findMany.mockResolvedValue([{ householdId: 'hh_1' }] as HouseholdMember[]);
      db.householdPlugin.findFirst.mockResolvedValue(null);

      await expect(service.hasQualifyingHouseholdForPlugin('user-1', 'plg_1')).resolves.toBe(false);
    });
  });
});
