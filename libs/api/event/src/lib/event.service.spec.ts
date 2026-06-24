import type { Event } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateEventDto } from './dto/create-event.dto';
import { EventService } from './event.service';

const COND = { id: 'sentinel-condition' };

describe('EventService', () => {
  let service: EventService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventService);
  });

  afterEach(() => jest.clearAllMocks());

  it('getEvents → read', async () => {
    db.event.findMany.mockResolvedValue([]);

    await service.getEvents({ offset: 0, limit: 20 } as never);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.read);
    expect(db.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null, AND: [COND] }) }),
    );
  });

  it('getEventById → read', async () => {
    db.event.findUnique.mockResolvedValue({ id: 'event-1' } as Event);

    await service.getEventById('event-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.read);
    expect(db.event.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'event-1', AND: [COND] }) }),
    );
  });

  it('throws NotFound when the event is not visible', async () => {
    db.event.findUnique.mockResolvedValue(null);
    await expect(service.getEventById('event-1')).rejects.toThrow(NotFoundException);
  });

  it('updateEvent → update', async () => {
    db.event.count.mockResolvedValue(1);
    db.event.update.mockResolvedValue({ id: 'event-1' } as Event);

    await service.updateEvent('event-1', { title: 'New' } as never);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.update);
    expect(db.event.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'event-1', AND: [COND] }) }),
    );
  });

  it('rejects an empty update patch', async () => {
    await expect(service.updateEvent('event-1', {} as never)).rejects.toThrow(BadRequestException);
  });

  it('deleteEvent → delete (soft)', async () => {
    db.event.count.mockResolvedValue(1);
    db.event.update.mockResolvedValue({ id: 'event-1' } as Event);

    await service.deleteEvent('event-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.delete);
    expect(db.event.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });

  it('createEvent does not filter by abilities', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue({ id: 'event-1', title: 'X' } as Event);

    await service.createEvent({ title: 'X' } as CreateEventDto);

    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
  });
});
