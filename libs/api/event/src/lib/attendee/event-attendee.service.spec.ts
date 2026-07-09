import type { EventAttendee, EventAttendeeGameList, GameCollection } from '@bge/database';
import { Action, EventParticipationStatus, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEventAttendee,
  makeEventAttendeeGameList,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventAttendeeService } from './event-attendee.service';
import {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
  GameAddedToListEvent,
  GameRemovedFromListEvent,
} from './events/attendee.events';

const COND = { id: 'sentinel-condition' };

describe('EventAttendeeService', () => {
  let service: EventAttendeeService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventAttendeeService,
        { provide: EventEmitter2, useValue: emitter },
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

    it('addAttendee emits an AttendeeAddedEvent with the created row snapshot', async () => {
      db.event.count.mockResolvedValue(1);
      abilityService.getActingUserId.mockReturnValue('user-host');
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-host' } as EventAttendee);
      db.eventAttendee.create.mockResolvedValue(
        makeEventAttendee({ id: 'att-1', eventId: 'event-1', userId: 'user-2', invitedById: 'att-host' }),
      );

      await service.addAttendee('event-1', { userId: 'user-2' });

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(AttendeeAddedEvent.eventName);
      expect(emitted).toBeInstanceOf(AttendeeAddedEvent);
      expect(emitted.action).toBe('create');
      expect(emitted.subjectId).toBe('att-1');
      expect(emitted.before).toBeNull();
      expect(emitted.after).toEqual(
        expect.objectContaining({ id: 'att-1', eventId: 'event-1', userId: 'user-2', invitedById: 'att-host' }),
      );
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

    it('removeAttendee emits an AttendeeRemovedEvent (before-only)', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendee.delete.mockResolvedValue(
        makeEventAttendee({ id: 'att-1', eventId: 'event-1', userId: 'user-1' }),
      );

      await service.removeAttendee('event-1', 'att-1');

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(AttendeeRemovedEvent.eventName);
      expect(emitted).toBeInstanceOf(AttendeeRemovedEvent);
      expect(emitted.action).toBe('delete');
      expect(emitted.subjectId).toBe('att-1');
      expect(emitted.after).toBeNull();
      expect(emitted.before).toEqual(expect.objectContaining({ id: 'att-1', eventId: 'event-1', userId: 'user-1' }));
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

    it('updateStatus emits an AttendeeStatusUpdatedEvent carrying the status transition', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
        status: EventParticipationStatus.Invited,
      } as EventAttendee);
      db.eventAttendee.update.mockResolvedValue(
        makeEventAttendee({
          id: 'att-1',
          eventId: 'event-1',
          userId: 'user-1',
          status: EventParticipationStatus.Attending,
        }),
      );

      await service.updateStatus('event-1', 'att-1', { status: EventParticipationStatus.Attending });

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(AttendeeStatusUpdatedEvent.eventName);
      expect(emitted).toBeInstanceOf(AttendeeStatusUpdatedEvent);
      expect(emitted.action).toBe('update');
      expect(emitted.subjectId).toBe('att-1');
      expect(emitted.before).toEqual({
        id: 'att-1',
        eventId: 'event-1',
        userId: 'user-1',
        status: EventParticipationStatus.Invited,
      });
      expect(emitted.after).toEqual({
        id: 'att-1',
        eventId: 'event-1',
        userId: 'user-1',
        status: EventParticipationStatus.Attending,
      });
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

    it('addGameToList emits a GameAddedToListEvent (create) for the new row', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.create.mockResolvedValue(makeEventAttendeeGameList('att-1', 'col-1', { id: 'gl-1' }));

      await service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' });

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(GameAddedToListEvent.eventName);
      expect(emitted).toBeInstanceOf(GameAddedToListEvent);
      expect(emitted.action).toBe('create');
      expect(emitted.subjectId).toBe('gl-1');
      expect(emitted.eventId).toBe('event-1');
      expect(emitted.before).toBeNull();
      expect(emitted.after).toEqual({ id: 'gl-1', attendeeId: 'att-1', collectionId: 'col-1' });
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

    it('removeGameFromList emits a GameRemovedFromListEvent (delete) for the removed row', async () => {
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendeeGameList.findUnique.mockResolvedValue(makeEventAttendeeGameList('att-1', 'col-1', { id: 'gl-1' }));
      db.eventAttendeeGameList.delete.mockResolvedValue(makeEventAttendeeGameList('att-1', 'col-1', { id: 'gl-1' }));

      await service.removeGameFromList('event-1', 'att-1', 'gl-1');

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(GameRemovedFromListEvent.eventName);
      expect(emitted).toBeInstanceOf(GameRemovedFromListEvent);
      expect(emitted.action).toBe('delete');
      expect(emitted.subjectId).toBe('gl-1');
      expect(emitted.eventId).toBe('event-1');
      expect(emitted.after).toBeNull();
      expect(emitted.before).toEqual({ id: 'gl-1', attendeeId: 'att-1', collectionId: 'col-1' });
    });
  });
});
