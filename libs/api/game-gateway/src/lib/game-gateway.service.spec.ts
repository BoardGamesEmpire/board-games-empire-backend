import type { GameGateway } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import { GatewayConfigEventsService } from '@bge/gateway-registry';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { CreateGameGatewayDto, UpdateGameGatewayDto } from './dto';
import { GameGatewayService } from './game-gateway.service';

const COND = { id: 'sentinel-condition' };

describe('GameGatewayService', () => {
  let service: GameGatewayService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let configEvents: jest.Mocked<Pick<GatewayConfigEventsService, 'publish'>>;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    configEvents = { publish: jest.fn().mockResolvedValue(undefined) };

    const ctx = await createTestingModuleWithDb({
      providers: [
        GameGatewayService,
        { provide: GatewayConfigEventsService, useValue: configEvents },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(GameGatewayService);
  });

  afterEach(() => jest.clearAllMocks());

  it('getAll → read, composed with the deletedAt filter', async () => {
    db.gameGateway.findMany.mockResolvedValue([]);

    await service.getAll({ offset: 0, limit: 20 } as never);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.GameGateway, Action.read);
    expect(db.gameGateway.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ AND: [COND, { deletedAt: null }] }) }),
    );
  });

  it('getById → read, composed with the deletedAt filter', async () => {
    db.gameGateway.findUniqueOrThrow.mockResolvedValue({ id: 'gw-1' } as GameGateway);

    await service.getById('gw-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.GameGateway, Action.read);
    expect(db.gameGateway.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'gw-1', AND: [COND, { deletedAt: null }] }) }),
    );
  });

  it('create does not filter by abilities and publishes a created event', async () => {
    db.gameGateway.create.mockResolvedValue({ id: 'gw-1' } as GameGateway);

    await service.create({ name: 'BGG' } as CreateGameGatewayDto);

    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
    expect(configEvents.publish).toHaveBeenCalledWith(expect.objectContaining({ changeType: 'created' }));
  });

  it('update → update (plain conditions, no deletedAt composition)', async () => {
    db.gameGateway.count.mockResolvedValue(1);
    db.gameGateway.update.mockResolvedValue({ id: 'gw-1' } as GameGateway);

    await service.update('gw-1', { name: 'New' } as UpdateGameGatewayDto);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.GameGateway, Action.update);
    expect(db.gameGateway.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'gw-1', AND: [COND] }) }),
    );
  });

  it('update rejects an empty patch', async () => {
    await expect(service.update('gw-1', {} as UpdateGameGatewayDto)).rejects.toThrow(BadRequestException);
  });

  it('delete → delete (soft) and publishes a deleted event', async () => {
    db.gameGateway.count.mockResolvedValue(1);
    db.gameGateway.update.mockResolvedValue({ id: 'gw-1' } as GameGateway);

    await service.delete('gw-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.GameGateway, Action.delete);
    expect(db.gameGateway.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'gw-1', AND: [COND] }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    expect(configEvents.publish).toHaveBeenCalledWith(expect.objectContaining({ changeType: 'deleted' }));
  });

  it('delete throws NotFound for a missing gateway', async () => {
    db.gameGateway.count.mockResolvedValue(0);
    await expect(service.delete('gw-1')).rejects.toThrow(NotFoundException);
  });
});
