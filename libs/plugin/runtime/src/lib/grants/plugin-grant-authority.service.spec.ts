import { DatabaseService, SystemRole, type HouseholdMember, type UserRole } from '@bge/database';
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

  // User-scope decisions carry no predicate here (#225 uniform enablement):
  // the subject check, tombstone gate, and manifest scope coherence are all
  // enforced by PluginGrantService.decide() itself, so this service exposes
  // nothing for that scope — asserted structurally rather than left implied.
  it('exposes no user-scope authority predicate', () => {
    expect('hasQualifyingHouseholdForPlugin' in service).toBe(false);
  });
});
