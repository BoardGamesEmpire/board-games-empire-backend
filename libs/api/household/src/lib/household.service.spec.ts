import type { Household } from '@bge/database';
import { Action, InviteStatus, Prisma, ResourceType } from '@bge/database';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaError } from '@status/codes';
import { HouseholdService } from './household.service';

const COND = { id: 'sentinel-condition' };

describe('HouseholdService', () => {
  let service: HouseholdService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId'>>;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser' | 'invalidateUsers'>>;

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue('user-1'),
    };
    permissions = {
      invalidateUser: jest.fn().mockResolvedValue(undefined),
      invalidateUsers: jest.fn().mockResolvedValue(undefined),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdService,
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdService);
  });

  afterEach(() => jest.clearAllMocks());

  it('getHouseholdsForUser → read', async () => {
    db.household.findMany.mockResolvedValue([]);

    await service.getHouseholdsForUser({ offset: 0, limit: 10 } as never);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.read);
    expect(db.household.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ AND: [COND] }) }),
    );
  });

  it('getHouseholdById → read', async () => {
    db.household.findUnique.mockResolvedValue({ id: 'hh-1', members: [] } as unknown as HouseholdWithMembers);

    await service.getHouseholdById('hh-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.read);
    expect(db.household.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'hh-1', AND: [COND] }) }),
    );
  });

  it('throws NotFound when the household does not exist (scoped read empty, probe finds nothing)', async () => {
    db.household.findUnique.mockResolvedValue(null);
    db.household.count.mockResolvedValue(0);

    await expect(service.getHouseholdById('hh-1')).rejects.toThrow(NotFoundException);
    expect(db.household.count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null } });
  });

  it('throws Forbidden when the household exists but is not visible to the actor', async () => {
    db.household.findUnique.mockResolvedValue(null);
    db.household.count.mockResolvedValue(1);

    await expect(service.getHouseholdById('hh-1')).rejects.toThrow(ForbiddenException);
  });

  it('samples member games DB-side and fetches only the sampled rows', async () => {
    db.household.findUnique.mockResolvedValue({
      id: 'hh-1',
      members: [
        {
          userId: 'member-1',
          user: { id: 'member-1', username: 'm1' },
          excludedFromHouseholds: [{ gameCollectionId: 'excluded-1' }],
        },
      ],
    } as unknown as HouseholdWithMembers);
    db.$queryRaw.mockResolvedValue([{ id: 'gc-1' }, { id: 'gc-2' }]);
    db.gameCollection.findMany.mockResolvedValue([
      { id: 'gc-1', platformGame: { id: 'pg-1', game: { id: 'g-1', title: 'A' } } },
      { id: 'gc-2', platformGame: { id: 'pg-2', game: { id: 'g-2', title: 'B' } } },
    ] as never);

    const result = await service.getHouseholdById('hh-1');

    // One bounded raw sample query...
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    // ...then a rich fetch scoped to only the sampled ids (never the full set).
    expect(db.gameCollection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['gc-1', 'gc-2'] } } }),
    );
    expect(result.members[0].user.gameCollections).toHaveLength(2);
  });

  it('skips the rich fetch when a member has no sampled games', async () => {
    db.household.findUnique.mockResolvedValue({
      id: 'hh-1',
      members: [{ userId: 'member-1', user: { id: 'member-1' }, excludedFromHouseholds: [] }],
    } as unknown as HouseholdWithMembers);
    db.$queryRaw.mockResolvedValue([]);

    const result = await service.getHouseholdById('hh-1');

    expect(db.gameCollection.findMany).not.toHaveBeenCalled();
    expect(result.members[0].user.gameCollections).toEqual([]);
  });

  it('create attributes the owner to the acting user (no userId param)', async () => {
    db.household.create.mockResolvedValue({ id: 'hh-1', createdById: 'user-1' } as Household);

    await service.create({ name: 'Home' } as never);

    expect(abilityService.getActingUserId).toHaveBeenCalledTimes(1);
    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
    expect(db.household.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdBy: { connect: { id: 'user-1' } },
          members: { create: expect.objectContaining({ userId: 'user-1' }) },
        }),
      }),
    );
    // The new owner's cached ability graph is evicted so their grants resolve.
    expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
  });

  it('updateHousehold → update', async () => {
    db.household.count.mockResolvedValue(1);
    db.household.update.mockResolvedValue({ id: 'hh-1' } as Household);

    await service.updateHousehold('hh-1', { name: 'New' } as never);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.update);
    expect(db.household.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'hh-1', AND: [COND] }) }),
    );
  });

  it('rejects an empty update patch', async () => {
    await expect(service.updateHousehold('hh-1', {} as never)).rejects.toThrow(BadRequestException);
  });

  it('deleteHousehold soft-deletes under the delete policy, revokes pending invites, and evicts member caches', async () => {
    db.household.count.mockResolvedValue(1);
    db.$transaction.mockImplementation((cb) => cb(db));
    db.household.update.mockResolvedValue({ id: 'hh-1' } as Household);
    db.invite.updateMany.mockResolvedValue({ count: 2 } as never);
    db.householdMember.findMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }] as never);

    await service.deleteHousehold('hh-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.delete);
    // Existence probed first (excludes soft-deleted).
    expect(db.household.count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null } });
    // Soft delete (stamp deletedAt), not a hard delete, gated by the scoped where.
    expect(db.household.delete).not.toHaveBeenCalled();
    expect(db.household.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'hh-1', deletedAt: null, AND: [COND] }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    // Outstanding invites to the dead household are revoked.
    expect(db.invite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          householdId: 'hh-1',
          status: { in: [InviteStatus.Pending, InviteStatus.AwaitingApproval] },
        }),
        data: { status: InviteStatus.Revoked },
      }),
    );
    // Every member's cached ability graph is evicted (household left their surface).
    expect(permissions.invalidateUsers).toHaveBeenCalledWith(['user-1', 'user-2']);
  });

  it('deleteHousehold 404s when the household does not exist (probe finds nothing)', async () => {
    db.household.count.mockResolvedValue(0);

    await expect(service.deleteHousehold('hh-1')).rejects.toThrow(NotFoundException);
    // Existence fails before any write — the transaction never runs.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(permissions.invalidateUsers).not.toHaveBeenCalled();
  });

  it('deleteHousehold 403s when it exists but the actor may not delete it (scoped update misses)', async () => {
    db.household.count.mockResolvedValue(1);
    db.$transaction.mockImplementation((cb) => cb(db));
    db.household.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('no rows', {
        code: PrismaError.DependentRecordNotFound,
        clientVersion: 'test',
      }),
    );

    await expect(service.deleteHousehold('hh-1')).rejects.toThrow(ForbiddenException);
    // The failed update rolls the transaction back — no invalidation runs.
    expect(permissions.invalidateUsers).not.toHaveBeenCalled();
  });

  it('reads exclude soft-deleted households (deletedAt: null filter)', async () => {
    db.household.findMany.mockResolvedValue([]);

    await service.getHouseholdsForUser({ offset: 0, limit: 10 } as never);

    expect(db.household.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });

  it('surfaces the empty-conditions Forbidden backstop on reads', async () => {
    abilityService.getCurrentResourceConditions.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.getHouseholdsForUser({ offset: 0, limit: 10 } as never)).rejects.toThrow(ForbiddenException);
  });
});

interface HouseholdWithMembers extends Household {
  members: { userId: string }[];
}
