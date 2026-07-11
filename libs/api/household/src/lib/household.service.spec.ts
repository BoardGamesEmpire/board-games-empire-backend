import type { Household } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HouseholdService } from './household.service';

const COND = { id: 'sentinel-condition' };

describe('HouseholdService', () => {
  let service: HouseholdService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId'>>;

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue('user-1'),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [HouseholdService, { provide: AbilityService, useValue: abilityService }],
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

  it('throws NotFound when the household is not visible', async () => {
    db.household.findUnique.mockResolvedValue(null);
    await expect(service.getHouseholdById('hh-1')).rejects.toThrow(NotFoundException);
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

  it('deleteHousehold → delete', async () => {
    db.household.count.mockResolvedValue(1);
    db.household.delete.mockResolvedValue({ id: 'hh-1' } as Household);

    await service.deleteHousehold('hh-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.delete);
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
