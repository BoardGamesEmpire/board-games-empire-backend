import type { Event } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEvent,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateEventDto } from './dto/create-event.dto';
import { EventCreatedEvent, EventDeletedEvent, EventUpdatedEvent } from './events/event.events';
import { EventService } from './event.service';

const COND = { id: 'sentinel-condition' };

describe('EventService', () => {
  let service: EventService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventService,
        { provide: EventEmitter2, useValue: emitter },
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
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Old' }));
    db.event.update.mockResolvedValue(makeEvent({ id: 'event-1', title: 'New' }));

    await service.updateEvent('event-1', { title: 'New' } as never);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.update);
    expect(db.event.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'event-1', AND: [COND] }) }),
    );
  });

  it('skips the update event when only relation-managed fields were patched', async () => {
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1' }));
    db.event.update.mockResolvedValue(makeEvent({ id: 'event-1' }));

    // occurrences/policy/inviteUserIds change no Event columns — an
    // empty-diff "update" audit row would be noise.
    await service.updateEvent('event-1', { occurrences: [] } as never);

    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('updateEvent emits an EventUpdatedEvent carrying the changed subset', async () => {
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Old' }));
    db.event.update.mockResolvedValue(makeEvent({ id: 'event-1', title: 'New' }));

    await service.updateEvent('event-1', { title: 'New' } as never);

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(EventUpdatedEvent.eventName);
    expect(emitted).toBeInstanceOf(EventUpdatedEvent);
    expect(emitted.action).toBe('update');
    expect(emitted.subjectId).toBe('event-1');
    expect(emitted.before).toEqual({ id: 'event-1', title: 'Old' });
    expect(emitted.after).toEqual({ id: 'event-1', title: 'New' });
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

  it('deleteEvent emits an EventDeletedEvent (before-only)', async () => {
    db.event.count.mockResolvedValue(1);
    db.event.update.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Doomed', createdById: 'user-1' }));

    await service.deleteEvent('event-1');

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(EventDeletedEvent.eventName);
    expect(emitted).toBeInstanceOf(EventDeletedEvent);
    expect(emitted.action).toBe('delete');
    expect(emitted.subjectId).toBe('event-1');
    expect(emitted.before).toEqual(expect.objectContaining({ id: 'event-1', title: 'Doomed' }));
    expect(emitted.after).toBeNull();
  });

  it('createEvent does not filter by abilities', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue({ id: 'event-1', title: 'X' } as Event);

    await service.createEvent({ title: 'X' } as CreateEventDto);

    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
  });

  it('createEvent emits an EventCreatedEvent with the created row snapshot', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue(makeEvent({ id: 'event-1', title: 'X', createdById: 'user-1' }));
    abilityService.getActingUserId.mockReturnValue('user-1');

    await service.createEvent({ title: 'X', inviteUserIds: ['user-2'] } as CreateEventDto);

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(EventCreatedEvent.eventName);
    expect(emitted).toBeInstanceOf(EventCreatedEvent);
    expect(emitted.action).toBe('create');
    expect(emitted.subjectId).toBe('event-1');
    expect(emitted.before).toBeNull();
    expect(emitted.after).toEqual(expect.objectContaining({ id: 'event-1', title: 'X', createdById: 'user-1' }));
    expect(emitted.invitedUserIds).toEqual(['user-2']);
  });
});
