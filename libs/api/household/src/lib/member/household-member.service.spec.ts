import { Action, Prisma, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { HouseholdMemberService, MEMBER_INCLUDE, type HouseholdMemberWithRelations } from './household-member.service';

const COND = { id: 'sentinel-condition' };
const PAGINATION = { offset: 0, limit: 10 };

const makeMember = (overrides: Partial<HouseholdMemberWithRelations> = {}): HouseholdMemberWithRelations =>
  ({
    id: 'member-1',
    userId: 'user-1',
    householdId: 'hh-1',
    showAllGames: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    user: {
      id: 'user-1',
      username: 'alice',
      profile: { avatarUrl: null, displayName: 'Alice' },
    },
    role: {
      id: 'hr-1',
      householdMemberId: 'member-1',
      roleId: 'role-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      role: { id: 'role-1', name: 'HouseholdMember' },
    },
    ...overrides,
  }) as HouseholdMemberWithRelations;

describe('HouseholdMemberService', () => {
  let service: HouseholdMemberService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions'>>;

  /**
   * Dispatches the two `householdMember.count` probes by shape rather than by
   * call order: the scoped probe carries the ability `AND`, the unscoped one
   * does not. Order-based mocking would silently pass if the probes were ever
   * reordered.
   */
  const stubCounts = ({ scoped, unscoped }: { scoped: number; unscoped: number }) => {
    db.householdMember.count.mockImplementation((args) => {
      const { where } = args as { where: Prisma.HouseholdMemberWhereInput };
      return Promise.resolve(where.AND ? scoped : unscoped) as Prisma.PrismaPromise<number>;
    });
  };

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [HouseholdMemberService, { provide: AbilityService, useValue: abilityService }],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdMemberService);

    // Household exists by default; individual tests override the probe.
    db.household.count.mockResolvedValue(1);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getMembers', () => {
    it('scopes the list by read conditions on HouseholdMember and shapes with MEMBER_INCLUDE', async () => {
      db.householdMember.findMany.mockResolvedValue([makeMember()]);

      const result = await service.getMembers('hh-1', PAGINATION);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.read,
      );
      expect(db.householdMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ householdId: 'hh-1', AND: [COND] }),
          include: MEMBER_INCLUDE,
          orderBy: { createdAt: 'asc' },
        }),
      );
      expect(result).toHaveLength(1);
    });

    it('asserts the household exists (excluding soft-deleted) before querying', async () => {
      db.householdMember.findMany.mockResolvedValue([makeMember()]);

      await service.getMembers('hh-1', PAGINATION);

      expect(db.household.count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null } });
    });

    it('forwards pagination as skip/take with the 10-row default', async () => {
      db.householdMember.findMany.mockResolvedValue([makeMember()]);

      await service.getMembers('hh-1', { offset: 20, limit: 5 });
      expect(db.householdMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 5 }));

      await service.getMembers('hh-1', { offset: 0 });
      expect(db.householdMember.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 0, take: 10 }));
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.getMembers('hh-missing', PAGINATION)).rejects.toThrow(NotFoundException);
      expect(db.householdMember.findMany).not.toHaveBeenCalled();
    });

    it('throws Forbidden when members exist but none are visible to the actor', async () => {
      db.householdMember.findMany.mockResolvedValue([]);
      stubCounts({ scoped: 0, unscoped: 4 });

      await expect(service.getMembers('hh-1', PAGINATION)).rejects.toThrow(ForbiddenException);

      expect(db.householdMember.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ householdId: 'hh-1', AND: [COND] }),
      });
      expect(db.householdMember.count).toHaveBeenCalledWith({ where: { householdId: 'hh-1' } });
    });

    it('returns an empty array — not Forbidden — for a household with no members at all', async () => {
      // Guards against depending on a "household always has >= 1 member"
      // invariant that nothing in the schema enforces (see #157).
      db.householdMember.findMany.mockResolvedValue([]);
      stubCounts({ scoped: 0, unscoped: 0 });

      await expect(service.getMembers('hh-1', PAGINATION)).resolves.toEqual([]);
    });

    it('returns an empty page when an authorized reader pages past the end', async () => {
      db.householdMember.findMany.mockResolvedValue([]);
      stubCounts({ scoped: 3, unscoped: 3 });

      await expect(service.getMembers('hh-1', { offset: 50, limit: 10 })).resolves.toEqual([]);
    });

    it('skips the unscoped probe when rows are visible to the actor', async () => {
      db.householdMember.findMany.mockResolvedValue([]);
      stubCounts({ scoped: 3, unscoped: 3 });

      await service.getMembers('hh-1', { offset: 50, limit: 10 });

      expect(db.householdMember.count).toHaveBeenCalledTimes(1);
    });

    it('skips both probes entirely when the page is non-empty', async () => {
      db.householdMember.findMany.mockResolvedValue([makeMember()]);

      await service.getMembers('hh-1', PAGINATION);

      expect(db.householdMember.count).not.toHaveBeenCalled();
    });
  });

  describe('getMember', () => {
    it('scopes the lookup by id + householdId + read conditions', async () => {
      db.householdMember.findUnique.mockResolvedValue(makeMember());

      const result = await service.getMember('hh-1', 'member-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.read,
      );
      expect(db.householdMember.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'member-1', householdId: 'hh-1', AND: [COND] }),
          include: MEMBER_INCLUDE,
        }),
      );
      expect(result.id).toBe('member-1');
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.getMember('hh-missing', 'member-1')).rejects.toThrow(NotFoundException);
      expect(db.householdMember.findUnique).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the member exists but is not visible to the actor', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);
      stubCounts({ scoped: 0, unscoped: 1 });

      await expect(service.getMember('hh-1', 'member-1')).rejects.toThrow(ForbiddenException);

      expect(db.householdMember.count).toHaveBeenCalledWith({ where: { id: 'member-1', householdId: 'hh-1' } });
    });

    it('throws NotFound when the member does not exist in the household', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);
      stubCounts({ scoped: 0, unscoped: 0 });

      await expect(service.getMember('hh-1', 'member-missing')).rejects.toThrow(NotFoundException);
    });

    it('uses the same scoped-then-unscoped probe order as getMembers', async () => {
      db.householdMember.findUnique.mockResolvedValue(null);
      stubCounts({ scoped: 0, unscoped: 1 });

      await expect(service.getMember('hh-1', 'member-1')).rejects.toThrow(ForbiddenException);

      const [first, second] = db.householdMember.count.mock.calls;
      expect(first[0]).toEqual(expect.objectContaining({ where: expect.objectContaining({ AND: [COND] }) }));
      expect(second[0]).toEqual({ where: { id: 'member-1', householdId: 'hh-1' } });
    });
  });
});
