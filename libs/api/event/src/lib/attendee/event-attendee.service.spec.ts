import type { EventAttendee, EventAttendeeGameList } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventAttendeeService } from './event-attendee.service';

const COND = { id: 'sentinel-condition' };

describe('EventAttendeeService', () => {
  let service: EventAttendeeService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventAttendeeService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventAttendeeService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('EventAttendee resource', () => {
    it('getAttendees → read', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);

      await service.getAttendees('event-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read);
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ eventId: 'event-1', AND: [COND] }) }),
      );
    });

    it('getAttendeeByUserId → read', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1' } as EventAttendee);

      await service.getAttendeeByUserId('event-1', 'user-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read);
    });

    it('removeAttendee → manage (matches the route gate, not delete)', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendee.delete.mockResolvedValue({ id: 'att-1' } as EventAttendee);

      await service.removeAttendee('event-1', 'att-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventAttendee,
        Action.manage,
      );
    });

    it('updateStatus → update', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
        status: 'Invited',
      } as EventAttendee);
      db.eventAttendee.update.mockResolvedValue({ id: 'att-1' } as EventAttendee);

      await service.updateStatus('event-1', 'att-1', { status: 'Attending' } as never);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventAttendee,
        Action.update,
      );
    });

    it('throws NotFound when removing a non-existent attendee', async () => {
      db.eventAttendee.findUnique.mockResolvedValue(null);
      await expect(service.removeAttendee('event-1', 'att-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('EventAttendeeGameList resource', () => {
    it('getGameList → read', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendeeGameList.findMany.mockResolvedValue([]);

      await service.getGameList('event-1', 'att-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventAttendeeGameList,
        Action.read,
      );
      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ attendeeId: 'att-1', AND: [COND] }) }),
      );
    });

    it('removeGameFromList → delete', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendeeGameList.findUnique.mockResolvedValue({
        id: 'gl-1',
        collectionId: 'col-1',
      } as EventAttendeeGameList);
      db.eventAttendeeGameList.delete.mockResolvedValue({ id: 'gl-1', collectionId: 'col-1' } as EventAttendeeGameList);

      await service.removeGameFromList('event-1', 'att-1', 'gl-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventAttendeeGameList,
        Action.delete,
      );
    });
  });
});
