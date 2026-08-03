import { Action, Prisma, ResourceType, SystemRole } from '@bge/database';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaError } from '@status/codes';
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

const makeOwner = (overrides: Partial<HouseholdMemberWithRelations> = {}): HouseholdMemberWithRelations =>
  makeMember({
    role: {
      id: 'hr-1',
      householdMemberId: 'member-1',
      roleId: 'role-owner',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      role: { id: 'role-owner', name: SystemRole.HouseholdOwner },
    },
    ...overrides,
  } as Partial<HouseholdMemberWithRelations>);

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('no rows', {
    code: PrismaError.DependentRecordNotFound,
    clientVersion: 'test',
  });

describe('HouseholdMemberService', () => {
  let service: HouseholdMemberService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId'>>;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser'>>;

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
      getActingUserId: jest.fn().mockReturnValue('actor-1'),
    };
    permissions = {
      invalidateUser: jest.fn().mockResolvedValue(undefined),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdMemberService,
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdMemberService);

    // Household exists by default; individual tests override the probe.
    db.household.count.mockResolvedValue(1);
    // Mutations run inside a transaction; unwrap onto the mock delegates.
    db.$transaction.mockImplementation((cb) => cb(db));
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

  describe('updateMemberRole', () => {
    const DTO = { role: SystemRole.HouseholdAdmin } as const;

    it('scopes the target by manage conditions, upserts the 1:1 role, and evicts the target cache', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember());
      db.householdMember.findUniqueOrThrow.mockResolvedValue(
        makeMember({
          role: {
            id: 'hr-1',
            householdMemberId: 'member-1',
            roleId: 'role-admin',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-02T00:00:00Z'),
            role: { id: 'role-admin', name: SystemRole.HouseholdAdmin },
          },
        } as Partial<HouseholdMemberWithRelations>),
      );

      const result = await service.updateMemberRole('hh-1', 'member-1', DTO);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.manage,
      );
      expect(db.householdMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'member-1', householdId: 'hh-1', AND: [COND] }),
          include: MEMBER_INCLUDE,
        }),
      );
      expect(db.householdRole.upsert).toHaveBeenCalledWith({
        where: { householdMemberId: 'member-1' },
        create: {
          householdMember: { connect: { id: 'member-1' } },
          role: { connect: { name: SystemRole.HouseholdAdmin } },
        },
        update: { role: { connect: { name: SystemRole.HouseholdAdmin } } },
      });
      // The re-read returns the post-write shape; the target's graph is evicted.
      expect(db.householdMember.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        include: MEMBER_INCLUDE,
      });
      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
      expect(result.role?.role.name).toBe(SystemRole.HouseholdAdmin);
    });

    it('upserts (create arm) for a member that has no role row yet', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember({ role: null }));
      db.householdMember.findUniqueOrThrow.mockResolvedValue(makeMember());

      await service.updateMemberRole('hh-1', 'member-1', { role: SystemRole.HouseholdGuest });

      expect(db.householdRole.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ role: { connect: { name: SystemRole.HouseholdGuest } } }),
        }),
      );
    });

    it('rejects changing your own role (400) without writing or invalidating', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember({ userId: 'actor-1' }));

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toThrow(BadRequestException);

      expect(db.householdRole.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('rejects changing an owner (400) — owner transitions belong to transfer-ownership (#158)', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner());

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toThrow(BadRequestException);

      expect(db.householdRole.upsert).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.updateMemberRole('hh-missing', 'member-1', DTO)).rejects.toThrow(NotFoundException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the member exists but the actor may not manage it', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(1);

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toThrow(ForbiddenException);
      expect(db.householdRole.upsert).not.toHaveBeenCalled();
    });

    it('throws NotFound when the member does not exist in the household', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(0);

      await expect(service.updateMemberRole('hh-1', 'member-missing', DTO)).rejects.toThrow(NotFoundException);
    });

    it('maps a write-time scoped miss (P2025) to Forbidden without invalidating', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember());
      db.householdRole.upsert.mockRejectedValue(dependentRecordNotFound());

      await expect(service.updateMemberRole('hh-1', 'member-1', DTO)).rejects.toThrow(ForbiddenException);
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });
  });

  describe('removeMember', () => {
    beforeEach(() => {
      db.excludedGame.deleteMany.mockResolvedValue({ count: 0 } as never);
      db.householdRole.deleteMany.mockResolvedValue({ count: 1 } as never);
      db.householdMember.delete.mockResolvedValue(makeMember() as never);
    });

    it('removes a non-owner member under the manage scope, cleaning dependents in order', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember());

      const result = await service.removeMember('hh-1', 'member-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.manage,
      );
      // A non-owner departure cannot violate the invariant — no owner lock.
      expect(db.$queryRaw).not.toHaveBeenCalled();

      expect(db.excludedGame.deleteMany).toHaveBeenCalledWith({ where: { householdMemberId: 'member-1' } });
      expect(db.householdRole.deleteMany).toHaveBeenCalledWith({ where: { householdMemberId: 'member-1' } });
      expect(db.householdMember.delete).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 'member-1', householdId: 'hh-1', AND: [COND] }),
      });

      // No cascades exist in the schema — dependents strictly before the member row.
      const excludedOrder = db.excludedGame.deleteMany.mock.invocationCallOrder[0];
      const roleOrder = db.householdRole.deleteMany.mock.invocationCallOrder[0];
      const memberOrder = db.householdMember.delete.mock.invocationCallOrder[0];
      expect(excludedOrder).toBeLessThan(roleOrder);
      expect(roleOrder).toBeLessThan(memberOrder);

      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
      expect(result.id).toBe('member-1');
    });

    it('locks the owner rows and allows removing an owner when another owner remains', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner());
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }, { household_member_id: 'member-2' }]);

      await service.removeMember('hh-1', 'member-1');

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(db.householdMember.delete).toHaveBeenCalled();
      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
    });

    it('rejects removing the sole owner (400) without deleting or invalidating', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner());
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }]);

      await expect(service.removeMember('hh-1', 'member-1')).rejects.toThrow(BadRequestException);

      expect(db.excludedGame.deleteMany).not.toHaveBeenCalled();
      expect(db.householdRole.deleteMany).not.toHaveBeenCalled();
      expect(db.householdMember.delete).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.removeMember('hh-missing', 'member-1')).rejects.toThrow(NotFoundException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the member exists but the actor may not manage it', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(1);

      await expect(service.removeMember('hh-1', 'member-1')).rejects.toThrow(ForbiddenException);
      expect(db.householdMember.delete).not.toHaveBeenCalled();
    });

    it('throws NotFound when the member does not exist in the household', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(0);

      await expect(service.removeMember('hh-1', 'member-missing')).rejects.toThrow(NotFoundException);
    });

    it('maps a write-time scoped miss (P2025) to Forbidden without invalidating', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember());
      db.householdMember.delete.mockRejectedValue(dependentRecordNotFound());

      await expect(service.removeMember('hh-1', 'member-1')).rejects.toThrow(ForbiddenException);
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });
  });

  describe('leaveHousehold', () => {
    beforeEach(() => {
      db.excludedGame.deleteMany.mockResolvedValue({ count: 0 } as never);
      db.householdRole.deleteMany.mockResolvedValue({ count: 1 } as never);
      db.householdMember.delete.mockResolvedValue(makeMember() as never);
    });

    it('scopes by delete conditions AND an explicit userId pin (manage implies delete for admins)', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeMember({ userId: 'actor-1' }));

      await service.leaveHousehold('hh-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.HouseholdMember,
        Action.delete,
      );
      // The pin is what makes "me" mean me: an Owner/Admin's delete conditions
      // (via CASL manage) cover every member of their household.
      expect(db.householdMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ householdId: 'hh-1', userId: 'actor-1', AND: [COND] }),
        }),
      );
      expect(db.householdMember.delete).toHaveBeenCalledWith({
        where: expect.objectContaining({ householdId: 'hh-1', userId: 'actor-1', AND: [COND], id: 'member-1' }),
      });
      expect(permissions.invalidateUser).toHaveBeenCalledWith('actor-1');
    });

    it('rejects the sole owner leaving (400) — transfer ownership first', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner({ userId: 'actor-1' }));
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }]);

      await expect(service.leaveHousehold('hh-1')).rejects.toThrow(BadRequestException);

      expect(db.householdMember.delete).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('allows an owner to leave when another owner remains', async () => {
      db.householdMember.findFirst.mockResolvedValue(makeOwner({ userId: 'actor-1' }));
      db.$queryRaw.mockResolvedValue([{ household_member_id: 'member-1' }, { household_member_id: 'member-2' }]);

      await service.leaveHousehold('hh-1');

      expect(db.householdMember.delete).toHaveBeenCalled();
      expect(permissions.invalidateUser).toHaveBeenCalledWith('actor-1');
    });

    it('throws NotFound when the acting user is not a member of the household', async () => {
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(0);

      await expect(service.leaveHousehold('hh-1')).rejects.toThrow(NotFoundException);
      expect(db.householdMember.delete).not.toHaveBeenCalled();
    });

    it('throws NotFound when the household does not exist', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.leaveHousehold('hh-missing')).rejects.toThrow(NotFoundException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });
});
