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

  describe('householdAdminStanding', () => {
    const ADMIN_ROLE = { role: { name: { in: [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin] } } };

    const membership = (deletedAt: Date | null) => ({ household: { deletedAt } }) as unknown as HouseholdMember;

    it('reads the owner/admin MEMBERSHIP once, with the household state riding along', async () => {
      db.householdMember.findFirst.mockResolvedValue(membership(null));

      await service.householdAdminStanding('user-1', 'hh_1');

      // No deletedAt filter in the where: the state must come back for the
      // deleted case, so one read answers all three.
      expect(db.householdMember.findFirst).toHaveBeenCalledTimes(1);
      expect(db.householdMember.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-1', householdId: 'hh_1', role: ADMIN_ROLE },
        select: { household: { select: { deletedAt: true } } },
      });
    });

    it('is admin for that membership in a live household', async () => {
      db.householdMember.findFirst.mockResolvedValue(membership(null));

      await expect(service.householdAdminStanding('user-1', 'hh_1')).resolves.toBe('admin');
    });

    it('is deleted, not admin, once the household is soft-deleted (#548)', async () => {
      // Member rows survive the soft delete, so the role alone would still make
      // the actor an admin of a household the API treats as gone.
      db.householdMember.findFirst.mockResolvedValue(membership(new Date('2026-10-14T00:00:00Z')));

      await expect(service.householdAdminStanding('user-1', 'hh_1')).resolves.toBe('deleted');
    });

    it('is none without the membership, whatever state the household is in', async () => {
      // A plain member, a stranger, a missing id and a deleted household the
      // user never administered all look the same here, so the answer cannot
      // tell an actor which households exist.
      db.householdMember.findFirst.mockResolvedValue(null);

      await expect(service.householdAdminStanding('user-1', 'hh_1')).resolves.toBe('none');
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
