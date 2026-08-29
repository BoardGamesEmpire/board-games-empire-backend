import type { Event } from '@bge/database';
import { Action, Prisma, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEvent,
  paginationQuery,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateEventDto } from './dto/create-event.dto';
import { EventService } from './event.service';
import { EventCreatedEvent, EventDeletedEvent, EventUpdatedEvent } from './events/event.events';

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
    db.event.count.mockResolvedValue(0);

    await service.getEvents(paginationQuery({ limit: 20 }));

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.read);
    expect(db.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null, AND: [COND] }) }),
    );
  });

  /**
   * The embedded occurrences carry the same tie-breaker as the dedicated
   * `GET /events/:eventId/occurrences` read. `sortOrder` is an `Int @default(0)`,
   * so un-reordered rows share a key, and a tie-less embedded sort would let
   * `GET /events` and the occurrences route disagree about their order — and
   * let the embedded order change between requests.
   */
  it('orders embedded occurrences totally, matching the dedicated occurrences read', async () => {
    db.event.findMany.mockResolvedValue([]);
    db.event.count.mockResolvedValue(0);

    await service.getEvents(paginationQuery({ limit: 20 }));

    const include = db.event.findMany.mock.calls[0][0]?.include as {
      occurrences?: { orderBy?: unknown };
    };
    expect(include?.occurrences?.orderBy).toEqual([{ sortOrder: 'asc' }, { id: 'asc' }]);
  });

  // #372: one snapshot for rows and count, and the soft-delete filter has to
  // reach the count too or `total` includes events no caller can page to.
  it('counts through the same where as the rows, in one REPEATABLE READ transaction', async () => {
    db.event.findMany.mockResolvedValue([]);
    db.event.count.mockResolvedValue(12);

    const page = await service.getEvents(paginationQuery({ limit: 20 }));

    expect(db.event.count).toHaveBeenCalledWith({ where: { deletedAt: null, AND: [COND] } });
    expect(page).toEqual({ rows: [], total: 12 });

    const { operations, options } = batchTransactionCall(db);
    expect(operations).toHaveLength(2);
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
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
