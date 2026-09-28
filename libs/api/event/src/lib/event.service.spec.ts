import type { Event } from '@bge/database';
import { Action, Prisma, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEvent,
  MOCK_ACTING_USER_ID,
  paginationQuery,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CreateEventDto } from './dto/create-event.dto';
import { EventService } from './event.service';
import { EventCreatedEvent, EventDeletedEvent, EventUpdatedEvent } from './events/event.events';

const COND = { id: 'sentinel-condition' };

describe('EventService', () => {
  let service: EventService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUsers'>>;
  let emitter: { emit: jest.Mock };
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    permissions = { invalidateUsers: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the list actually runs.
        ScopeComposer,
        { provide: EventEmitter2, useValue: emitter },
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * #512. `GET /events` used to take the caller's ceiling as its answer set, so
   * one route returned a plain user the events they attend, a household member
   * every event in their households, a friend their friends' `Friends`-visible
   * events, and staff every event on the server, with `total` scoped the same
   * way. It now declares its own set, the events the caller is an attendee of
   * whatever their RSVP, and the ceiling only clips it. The by-id read is
   * unchanged, so an event dropped from the list is narrowed out of it, not
   * withdrawn.
   *
   * `Event` has left `PENDING_SCOPE_SWEEP`, so a regression that stops this read
   * composing answers 500 at the envelope rather than returning too much. That
   * is why the first test pins the composer call itself.
   */
  describe('getEvents, as a converted event list', () => {
    const read = () => service.getEvents(paginationQuery({ limit: 20 }));

    beforeEach(() => {
      db.event.findMany.mockResolvedValue([]);
      db.event.count.mockResolvedValue(0);
    });

    it('asks the composer for its where clause, declaring the events the caller is an attendee of', async () => {
      await read();

      expect(compose).toHaveBeenCalledWith(ResourceType.Event, Action.read, {
        deletedAt: null,
        attendees: { some: { userId: MOCK_ACTING_USER_ID } },
      });
    });

    // Asking is not enough: the query has to use the answer. The ceiling stays
    // ANDed in, because for an `apiKey` actor it carries the key ∩ owner floor.
    // `deletedAt: null` stays because a soft delete keeps the attendee rows, so
    // the attendance clause alone still matches a deleted event.
    it('queries with the composed clause, the ceiling clipping its scope rather than supplying it', async () => {
      await read();

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.read);
      expect(db.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, attendees: { some: { userId: MOCK_ACTING_USER_ID } }, AND: [COND] },
        }),
      );
    });

    // #372: one snapshot for rows and count, and the count has to see the same
    // clause, or `total` describes a population the caller is not paged through.
    it('counts through the same where as the rows, in one REPEATABLE READ transaction', async () => {
      db.event.count.mockResolvedValue(12);

      const page = await read();

      const [findManyArgs] = db.event.findMany.mock.calls[0] as [{ where: unknown }];
      expect(db.event.count).toHaveBeenCalledWith({ where: findManyArgs.where });
      expect(page).toEqual({ rows: [], total: 12 });

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    /**
     * The embedded occurrences carry the same tie-breaker as the dedicated
     * `GET /events/:eventId/occurrences` read. `sortOrder` is an `Int @default(0)`,
     * so un-reordered rows share a key, and a tie-less embedded sort would let
     * `GET /events` and the occurrences route disagree about their order — and
     * let the embedded order change between requests.
     */
    it('orders embedded occurrences totally, matching the dedicated occurrences read', async () => {
      await read();

      const include = db.event.findMany.mock.calls[0][0]?.include as {
        occurrences?: { orderBy?: unknown };
      };
      expect(include?.occurrences?.orderBy).toEqual([{ sortOrder: 'asc' }, { id: 'asc' }]);
    });

    // PROVISIONAL (#395). "The events I attend" has no meaning for an actor
    // with no user behind it, and the refusal must stay one: an empty page
    // would tell a client it attends nothing. The key is the read's own, not
    // the write-flavoured one `getActingUserId` throws.
    it('refuses an actor kind with no user behind it rather than answering an empty page', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await read().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.event.findMany).not.toHaveBeenCalled();
    });
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

  // The route's policy check judges a create by type alone, so it passes
  // every user: `create:event` exists for all of them. Which household the
  // event joins is what decides it, and only the service knows that.
  it('createEvent checks the create against the household the event would join', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
    db.event.create.mockResolvedValue(makeEvent({ id: 'event-1', householdId: 'hh-1' }));

    await service.createEvent({ title: 'X', householdId: 'hh-1' } as CreateEventDto);

    expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.Event, {
      householdId: 'hh-1',
    });
  });

  // The ability check passes on a graph that can predate a soft-delete, and
  // the site Owner's passes for any household. The lock inside the write is
  // what finds the household dead.
  it('createEvent answers 404 and writes nothing when the household is not live at the write', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.$queryRaw.mockResolvedValue([] as never);

    await expect(service.createEvent({ title: 'X', householdId: 'hh-gone' } as CreateEventDto)).rejects.toThrow(
      NotFoundException,
    );
    expect(db.event.create).not.toHaveBeenCalled();
  });

  it('createEvent names a null household for an event outside any household', async () => {
    // Not omitted: the matcher reads a missing field as `null`, so a subject
    // without it would pass as an event outside any household whatever the
    // write named.
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue(makeEvent({ id: 'event-1' }));

    await service.createEvent({ title: 'X' } as CreateEventDto);

    expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.Event, {
      householdId: null,
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('createEvent refuses before writing when the instance check denies', async () => {
    abilityService.assertCurrentActorCan.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.createEvent({ title: 'X', householdId: 'hh-2' } as CreateEventDto)).rejects.toThrow(
      ForbiddenException,
    );
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.event.create).not.toHaveBeenCalled();
  });

  // The creator's graph was cached by this very request, before the host row
  // existed; without the eviction they cannot manage the event they just
  // created until the cache expires. Each invitee gains a role the same way.
  it("createEvent evicts the creator's and every invitee's cached permission graph", async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue(makeEvent({ id: 'event-1', createdById: 'user-1' }));
    abilityService.getActingUserId.mockReturnValue('user-1');

    await service.createEvent({ title: 'X', inviteUserIds: ['user-2', 'user-3', 'user-1'] } as CreateEventDto);

    expect(permissions.invalidateUsers).toHaveBeenCalledWith(['user-1', 'user-2', 'user-3']);
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
