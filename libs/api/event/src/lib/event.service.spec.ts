import type { Event } from '@bge/database';
import {
  Action,
  EventSchedulingMode,
  EventStatus,
  FriendshipStatus,
  HUMAN_USER_WHERE,
  OccurrenceStatus,
  Prisma,
  Reach,
  ResourceType,
} from '@bge/database';
import { uniqueViolationWithoutMeta } from '@bge/database/testing';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEvent,
  makeEventOccurrence,
  makeEventPolicy,
  MOCK_ACTING_USER_ID,
  unwrapTransaction,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { EVENT_CREATE_INCLUDE } from './constants/event-create-include.constant';
import type { CreateEventDto } from './dto/create-event.dto';
import { ListEventsQueryDto } from './dto/list-events.query.dto';
import { EventService } from './event.service';
import { EventCreatedEvent, EventDeletedEvent, EventUpdatedEvent } from './events/event.events';
import { EVENT_STATUS_DATE_SELECT } from './utils/event-status.util';

const COND = { id: 'sentinel-condition' };

/** A confirmed date a day from now, which makes an event Scheduled (#795). */
const futureDate = () =>
  makeEventOccurrence({
    eventId: 'event-1',
    status: OccurrenceStatus.Confirmed,
    startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    endDate: null,
  });

/**
 * An event as a create or an update reads it back: with every date of the
 * event, which its status is worked out from (#795).
 */
const withDates = <T extends Event>(event: T, occurrences: ReturnType<typeof makeEventOccurrence>[] = []) => ({
  ...event,
  occurrences,
});

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

    // Every invitee is a person unless a test says otherwise. The invite
    // checks' other reads find no row: the default policy and preference,
    // and no friendship.
    db.user.findUnique.mockImplementation(((args: { where: { id: string } }) =>
      Promise.resolve({ id: args.where.id })) as never);

    // An event has no dates unless a test gives it some, so its status read
    // finds none (#795).
    db.eventOccurrence.findMany.mockResolvedValue([]);
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
   * `Event`'s envelope is guarded, so a regression that stops this read
   * composing answers 500 at the envelope rather than returning too much. That
   * is why the first test pins the composer call itself.
   */
  describe('getEvents, as a converted event list', () => {
    const read = (init: Record<string, unknown> = {}) =>
      service.getEvents(
        plainToInstance(ListEventsQueryDto, { limit: 20, ...init }, { enableImplicitConversion: true }),
      );

    beforeEach(() => {
      db.event.findMany.mockResolvedValue([]);
      db.event.count.mockResolvedValue(0);
    });

    it('asks the composer for its where clause, declaring the events the caller is an attendee of', async () => {
      await read();

      // A row a host removed keeps no role, so its event is not the caller's.
      // An archived event is left out unless asked for (#795).
      expect(compose).toHaveBeenCalledWith(ResourceType.Event, Action.read, {
        deletedAt: null,
        archivedAt: null,
        attendees: { some: { userId: MOCK_ACTING_USER_ID, removedAt: null } },
      });
    });

    it('lists archived events too when asked to (#795)', async () => {
      await read({ includeArchived: 'true' });

      expect(compose).toHaveBeenCalledWith(ResourceType.Event, Action.read, {
        deletedAt: null,
        attendees: { some: { userId: MOCK_ACTING_USER_ID, removedAt: null } },
      });
    });

    // The list embeds every date of each event, unclipped, so each row's
    // status comes from its own embed with no read of its own.
    it('serves each row with the status its embedded dates give it (#795)', async () => {
      db.event.findMany.mockResolvedValue([
        { ...makeEvent({ id: 'event-1' }), occurrences: [futureDate()] },
        { ...makeEvent({ id: 'event-2' }), occurrences: [] },
      ] as never);

      const { rows } = await read();

      expect(rows.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'event-1', status: EventStatus.Scheduled },
        { id: 'event-2', status: EventStatus.Planning },
      ]);
      expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
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
          where: {
            deletedAt: null,
            archivedAt: null,
            attendees: { some: { userId: MOCK_ACTING_USER_ID, removedAt: null } },
            AND: [COND],
          },
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

  /**
   * #560. The event read embedded its occurrences, attendees and policy, so
   * each went to whoever could read the event: a friend of the host, or a
   * household guest, got every attendee. Each is now a read of its own, with
   * its type's ceiling in that read's top-level `where`, the only place a
   * deny-all ceiling is enforced (#559).
   */
  describe('getEventById', () => {
    const event = makeEvent({ id: 'event-1' });

    beforeEach(() => {
      db.event.findUnique.mockResolvedValue(event);
      db.eventOccurrence.findMany.mockResolvedValue([]);
      db.eventAttendee.findMany.mockResolvedValue([]);
      db.eventPolicy.findUnique.mockResolvedValue(null);
    });

    // Exact, so an embed put back on the event read fails here.
    it('reads the event under its own ceiling, embedding nothing', async () => {
      await service.getEventById('event-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.read);
      expect(db.event.findUnique).toHaveBeenCalledWith({ where: { id: 'event-1', deletedAt: null, AND: [COND] } });
    });

    it("reads the occurrences and attendees as the event's lists, each composed with its own type's ceiling", async () => {
      await service.getEventById('event-1');

      expect(compose).toHaveBeenCalledWith(ResourceType.EventOccurrence, Action.read, { eventId: 'event-1' });
      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({
        where: { eventId: 'event-1', AND: [COND] },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });

      // Without the attendees a host removed.
      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, {
        eventId: 'event-1',
        removedAt: null,
      });
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: { eventId: 'event-1', removedAt: null, AND: [COND] },
        include: {
          user: { select: { id: true, username: true, profile: { select: { avatarUrl: true, displayName: true } } } },
          role: { include: { role: { select: { id: true, name: true } } } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });

    it("reads the event's policy under the policy ceiling", async () => {
      await service.getEventById('event-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.EventPolicy, Action.read);
      expect(db.eventPolicy.findUnique).toHaveBeenCalledWith({ where: { eventId: 'event-1', AND: [COND] } });
    });

    it('serves each part as its own read returned it, under the keys the embed used', async () => {
      const occurrence = makeEventOccurrence({ id: 'occ-1', eventId: 'event-1' });
      const policy = makeEventPolicy('event-1');
      db.eventOccurrence.findMany.mockResolvedValueOnce([occurrence]);
      db.eventPolicy.findUnique.mockResolvedValue(policy);

      await expect(service.getEventById('event-1')).resolves.toEqual({
        ...event,
        status: EventStatus.Planning,
        occurrences: [occurrence],
        attendees: [],
        policy,
      });
    });

    // An actor whose occurrence ceiling clips the dates still gets the
    // event's own status: it is a fact about the event, not about the dates
    // they may list.
    it('works out the status from every date, not only the dates the actor may read (#795)', async () => {
      db.eventOccurrence.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([futureDate()]);

      const detail = await service.getEventById('event-1');

      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({
        where: { eventId: 'event-1' },
        select: EVENT_STATUS_DATE_SELECT,
      });
      expect(detail.occurrences).toEqual([]);
      expect(detail.status).toBe(EventStatus.Scheduled);
    });

    it('takes the five reads from one REPEATABLE READ snapshot', async () => {
      await service.getEventById('event-1');

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(5);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    it('throws NotFound when the event is not visible', async () => {
      db.event.findUnique.mockResolvedValue(null);
      await expect(service.getEventById('event-1')).rejects.toThrow(NotFoundException);
    });
  });

  it('updateEvent → update', async () => {
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Old' }));
    db.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New' })));

    await service.updateEvent('event-1', { title: 'New' } as never);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.update);
    expect(db.event.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'event-1', AND: [COND] }) }),
    );
  });

  it('skips the update event when only relation-managed fields were patched', async () => {
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1' }));
    db.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1' })));

    // occurrences/policy/inviteUserIds change no Event columns — an
    // empty-diff "update" audit row would be noise.
    await service.updateEvent('event-1', { occurrences: [] } as never);

    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('updateEvent emits an EventUpdatedEvent carrying the changed subset', async () => {
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Old' }));
    db.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New' })));

    await service.updateEvent('event-1', { title: 'New' } as never);

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(EventUpdatedEvent.eventName);
    expect(emitted).toBeInstanceOf(EventUpdatedEvent);
    expect(emitted.action).toBe('update');
    expect(emitted.subjectId).toBe('event-1');
    expect(emitted.before).toEqual({ id: 'event-1', title: 'Old' });
    expect(emitted.after).toEqual({ id: 'event-1', title: 'New' });
  });

  // #538. Names only: `data` is copied verbatim to a URL the subscriber
  // controls, and Event carries a `location` that may be a home address. A
  // receiver reads the values with its own credentials.
  it('updateEvent sends event.event.updated.v1 naming the changed columns, never their values', async () => {
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Old', householdId: 'hh-1' }));
    db.event.update.mockResolvedValue(
      withDates(makeEvent({ id: 'event-1', title: 'New', location: '12 Home Street', householdId: 'hh-1' })),
    );

    await service.updateEvent('event-1', { title: 'New', location: '12 Home Street' } as never);

    // No occurrenceId: two updates to one event are different occurrences,
    // and nothing here names one stably (#127).
    expect(emitter.emit).toHaveBeenCalledWith(WebhookEventType.EventUpdated, {
      subjectId: 'event-1',
      householdId: 'hh-1',
      data: { eventId: 'event-1', householdId: 'hh-1', changedFields: ['title', 'location'] },
    });
    expect(emitter.emit.mock.calls.find(([name]) => name === WebhookEventType.EventUpdated)?.[1]).not.toHaveProperty(
      'occurrenceId',
      expect.anything(),
    );
  });

  it('updateEvent names only the columns whose values changed, not every key the patch sent', async () => {
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Old', location: 'Same Hall' }));
    db.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New', location: 'Same Hall' })));

    await service.updateEvent('event-1', { title: 'New', location: 'Same Hall' } as never);

    const [, sent] = emitter.emit.mock.calls.find(([name]) => name === WebhookEventType.EventUpdated) ?? [];
    expect(sent?.data.changedFields).toEqual(['title']);
  });

  it('updateEvent sends no webhook when the patch changes no value', async () => {
    // A form that re-sends what it loaded would otherwise post "updated" to
    // every subscriber for a change that never happened.
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Same' }));
    db.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'Same' })));

    await service.updateEvent('event-1', { title: 'Same' } as never);

    expect(emitter.emit).not.toHaveBeenCalledWith(WebhookEventType.EventUpdated, expect.anything());
  });

  // From the dates the update reads back, with no read after the commit: a
  // failed one would report a patch that happened as one that didn't.
  it('updateEvent serves the status worked out from the dates it reads back (#795)', async () => {
    db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Old' }));
    db.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New' }), [futureDate()]));

    const updated = await service.updateEvent('event-1', { title: 'New' } as never);

    expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
    expect(updated.status).toBe(EventStatus.Scheduled);
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

  it('deleteEvent sends event.event.deleted.v1 with ids only, keyed on the event', async () => {
    db.event.count.mockResolvedValue(1);
    db.event.update.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Doomed', householdId: null }));

    await service.deleteEvent('event-1');

    // An event is deleted once (nothing restores one), so its id names the
    // occurrence and a re-emit dedups to one delivery while the first is still
    // queued.
    expect(emitter.emit).toHaveBeenCalledWith(WebhookEventType.EventDeleted, {
      subjectId: 'event-1',
      householdId: null,
      occurrenceId: 'event-1',
      data: { eventId: 'event-1', householdId: null },
    });
  });

  // Read before the delete, so a failed read leaves the event as it was
  // rather than reporting a delete that happened as one that didn't.
  it('deleteEvent serves the status the event had from its dates, read before the delete (#795)', async () => {
    db.event.count.mockResolvedValue(1);
    db.event.update.mockResolvedValue(makeEvent({ id: 'event-1' }));
    db.eventOccurrence.findMany.mockResolvedValue([futureDate()]);

    await expect(service.deleteEvent('event-1')).resolves.toEqual(
      expect.objectContaining({ id: 'event-1', status: EventStatus.Scheduled }),
    );
    expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({
      where: { eventId: 'event-1' },
      select: EVENT_STATUS_DATE_SELECT,
    });
    expect(db.eventOccurrence.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.event.update.mock.invocationCallOrder[0],
    );
  });

  // From the dates the create reads back, with no read after the commit.
  it('createEvent serves the status worked out from the dates it reads back (#795)', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-1' }), [futureDate()]));

    const created = await service.createEvent({ title: 'X' } as CreateEventDto);

    expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
    expect(created.status).toBe(EventStatus.Scheduled);
  });

  it('createEvent does not filter by abilities', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue(withDates({ id: 'event-1', title: 'X' } as Event));

    await service.createEvent({ title: 'X' } as CreateEventDto);

    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
  });

  // The route's policy check judges a create by type alone, so it passes
  // every user: `create:event` exists for all of them. Which household the
  // event joins is what decides it, and only the service knows that.
  it('createEvent checks the create against the household the event would join', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
    db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-1', householdId: 'hh-1' })));

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
    db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-1' })));

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

  describe('whom createEvent may invite (#546)', () => {
    beforeEach(() => {
      db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
      db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-1', createdById: 'user-1' })));
      abilityService.getActingUserId.mockReturnValue('user-1');
    });

    it('answers 404 for an invitee id that names no person, and writes nothing', async () => {
      db.user.findUnique.mockImplementation(((args: { where: { id: string } }) =>
        Promise.resolve(args.where.id === 'ghost' ? null : { id: args.where.id })) as never);

      await expect(
        service.createEvent({ title: 'X', inviteUserIds: ['user-2', 'ghost'] } as CreateEventDto),
      ).rejects.toThrow(NotFoundException);
      expect(db.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ghost', ...HUMAN_USER_WHERE } }),
      );
      expect(db.event.create).not.toHaveBeenCalled();
    });

    it("answers 403 for an invitee the server's event policy keeps out, and writes nothing", async () => {
      db.systemSetting.findUnique.mockResolvedValue({
        householdInviteePolicy: Reach.Public,
        eventInviteePolicy: Reach.Friends,
      } as never);

      await expect(service.createEvent({ title: 'X', inviteUserIds: ['user-2'] } as CreateEventDto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(db.event.create).not.toHaveBeenCalled();
    });

    it("lets in an invitee the server's household policy alone would keep out", async () => {
      db.systemSetting.findUnique.mockResolvedValue({
        householdInviteePolicy: Reach.Friends,
        eventInviteePolicy: Reach.Public,
      } as never);

      await service.createEvent({ title: 'X', inviteUserIds: ['user-2'] } as CreateEventDto);

      expect(db.event.create).toHaveBeenCalled();
    });

    it("lets in a friend under the server's Friends policy", async () => {
      db.systemSetting.findUnique.mockResolvedValue({ eventInviteePolicy: Reach.Friends } as never);
      db.friendship.findFirst.mockResolvedValue({ status: FriendshipStatus.Accepted } as never);

      await service.createEvent({ title: 'X', inviteUserIds: ['user-2'] } as CreateEventDto);

      expect(db.event.create).toHaveBeenCalled();
    });

    // The event's own settings and words, not the household's (#496).
    it("lets in a friend of a friend under the server's FriendsOfFriends event policy", async () => {
      db.systemSetting.findUnique.mockResolvedValue({
        householdInviteePolicy: Reach.Friends,
        eventInviteePolicy: Reach.FriendsOfFriends,
      } as never);
      db.user.count.mockResolvedValue(1);

      await service.createEvent({ title: 'X', inviteUserIds: ['user-2'] } as CreateEventDto);

      expect(db.event.create).toHaveBeenCalled();
    });

    it("refuses someone no friend links under the server's FriendsOfFriends event policy, in its own words", async () => {
      db.systemSetting.findUnique.mockResolvedValue({
        householdInviteePolicy: Reach.Public,
        eventInviteePolicy: Reach.FriendsOfFriends,
      } as never);
      db.user.count.mockResolvedValue(0);

      const error = await service
        .createEvent({ title: 'X', inviteUserIds: ['user-2'] } as CreateEventDto)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).message).toContain('errors.event.invitee_friends_of_friends_only');
      expect(db.event.create).not.toHaveBeenCalled();
    });

    it('asks nothing about the creator listed among the invitees', async () => {
      await service.createEvent({ title: 'X', inviteUserIds: ['user-1'] } as CreateEventDto);

      expect(db.user.findUnique).not.toHaveBeenCalled();
    });
  });

  // The creator's graph was cached by this very request, before the host row
  // existed; without the eviction they cannot manage the event they just
  // created until the cache expires. Each invitee gains a role the same way.
  it("createEvent evicts the creator's and every invitee's cached permission graph", async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-1', createdById: 'user-1' })));
    abilityService.getActingUserId.mockReturnValue('user-1');

    await service.createEvent({ title: 'X', inviteUserIds: ['user-2', 'user-3', 'user-1'] } as CreateEventDto);

    expect(permissions.invalidateUsers).toHaveBeenCalledWith(['user-1', 'user-2', 'user-3']);
  });

  it('createEvent sends event.event.created.v1 with ids only, keyed on the event', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
    db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'X', householdId: 'hh-1' })));

    await service.createEvent({ title: 'X', householdId: 'hh-1' } as CreateEventDto);

    // An event is created once, so its id names the occurrence.
    expect(emitter.emit).toHaveBeenCalledWith(WebhookEventType.EventCreated, {
      subjectId: 'event-1',
      householdId: 'hh-1',
      occurrenceId: 'event-1',
      data: { eventId: 'event-1', householdId: 'hh-1' },
    });
  });

  it('createEvent emits an EventCreatedEvent with the created row snapshot', async () => {
    db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
    db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'X', createdById: 'user-1' })));
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

  describe('what createEvent writes', () => {
    const startDate = new Date('2026-11-01T18:00:00.000Z');
    const endDate = new Date('2026-11-01T22:00:00.000Z');

    beforeEach(() => {
      db.$transaction.mockImplementation(async (cb: (tx: MockDatabaseService) => unknown) => cb(db));
      db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-1', createdById: MOCK_ACTING_USER_ID })));
    });

    /** What the `call`-th create wrote. */
    const written = (call = 0) => db.event.create.mock.calls[call][0].data;

    it('schedules a fixed event, confirming its one occurrence with a policy of its own', async () => {
      await service.createEvent({
        title: 'X',
        occurrences: [{ label: 'Night', startDate, endDate, location: 'Den' }],
      } as CreateEventDto);

      expect(written().occurrences).toEqual({
        create: [
          {
            label: 'Night',
            startDate,
            endDate,
            location: 'Den',
            sortOrder: 0,
            policy: { create: {} },
            status: OccurrenceStatus.Confirmed,
            confirmedAt: expect.any(Date),
          },
        ],
      });
    });

    // A poll's occurrences are the candidates its votes choose between, so
    // none is confirmed and none gets a policy until one is chosen.
    it('plans a poll, proposing each occurrence in the order given unless it names its own', async () => {
      await service.createEvent({
        title: 'X',
        schedulingMode: EventSchedulingMode.Poll,
        occurrences: [{ startDate, sortOrder: 5 }, { startDate: endDate }],
      } as CreateEventDto);

      expect(written()).toHaveProperty('occurrences.create', [
        expect.objectContaining({
          sortOrder: 5,
          policy: undefined,
          status: OccurrenceStatus.Proposed,
          confirmedAt: null,
        }),
        expect.objectContaining({
          sortOrder: 1,
          policy: undefined,
          status: OccurrenceStatus.Proposed,
          confirmedAt: null,
        }),
      ]);
    });

    it('writes no status: the event stores decisions, and the rest comes from its dates (#795)', async () => {
      await service.createEvent({ title: 'X', schedulingMode: EventSchedulingMode.Poll } as CreateEventDto);
      await service.createEvent({ title: 'X', occurrences: [{ startDate }] } as CreateEventDto);

      expect(written(0)).not.toHaveProperty('status');
      expect(written(1)).not.toHaveProperty('status');
    });

    it('writes no occurrences for an empty list', async () => {
      await service.createEvent({ title: 'X', occurrences: [] } as unknown as CreateEventDto);

      expect(written().occurrences).toBeUndefined();
    });

    it('refuses a fixed event with more than one occurrence before writing', async () => {
      await expect(
        service.createEvent({ title: 'X', occurrences: [{ startDate }, { startDate: endDate }] } as CreateEventDto),
      ).rejects.toThrow(BadRequestException);
      expect(db.event.create).not.toHaveBeenCalled();
    });

    it('creates an empty policy when the request names none', async () => {
      await service.createEvent({ title: 'X' } as CreateEventDto);

      expect(written().policy).toEqual({ create: {} });
    });

    it("links the policy's allowed categories when it names some", async () => {
      await service.createEvent({
        title: 'X',
        policy: { restrictToGameCategories: true, allowedCategoryIds: ['cat-1', 'cat-2'] },
      } as CreateEventDto);

      expect(written()).toMatchObject({
        policy: {
          create: {
            restrictToGameCategories: true,
            allowedCategories: {
              create: [{ category: { connect: { id: 'cat-1' } } }, { category: { connect: { id: 'cat-2' } } }],
            },
          },
        },
      });
    });

    it('links no categories for an empty or absent list', async () => {
      await service.createEvent({ title: 'X', policy: { allowedCategoryIds: [] } } as unknown as CreateEventDto);
      await service.createEvent({ title: 'X', policy: { maxAttendees: 6 } } as CreateEventDto);

      expect(written(0)).not.toHaveProperty('policy.create.allowedCategories');
      expect(written(1)).not.toHaveProperty('policy.create.allowedCategories');
      expect(written(1)).toHaveProperty('policy.create.maxAttendees', 6);
    });
  });

  describe('createEvent with a client request id (#252)', () => {
    // The event a first attempt made, as the replay lookup reads it.
    const original = makeEvent({ id: 'event-1', title: 'Original', createdById: 'user-1' });
    const occurrence = makeEventOccurrence({ id: 'occ-1', eventId: 'event-1' });
    const policy = makeEventPolicy('event-1');

    // Every attendee row on the event: its host, one invitee, and a guest, who
    // has no account and so no graph to evict.
    const attendeeRows = [{ userId: 'user-1' }, { userId: 'user-3' }, { userId: null }];

    // A retry whose payload differs from the original's, in a household that
    // has since been deleted: the replay must answer with the original anyway.
    const retry = {
      title: 'Different',
      householdId: 'hh-gone',
      inviteUserIds: ['user-9'],
      clientRequestId: 'k',
    } as CreateEventDto;

    /** The attendees the replay's scoped read returns; the eviction's unscoped read gets every row. */
    const attendeesReadAs = (scoped: unknown[]) =>
      db.eventAttendee.findMany.mockImplementation(((args: { select?: unknown }) =>
        Promise.resolve(args.select ? attendeeRows : scoped)) as never);

    beforeEach(() => {
      abilityService.getActingUserId.mockReturnValue('user-1');
      unwrapTransaction(db);
      db.eventOccurrence.findMany.mockResolvedValue([occurrence]);
      db.eventPolicy.findUnique.mockResolvedValue(policy);
      attendeesReadAs([]);
    });

    it('replays the event already under the key, before any check, lock or write', async () => {
      db.event.findUnique.mockResolvedValue(original);

      // Its one date, in 2024, has passed (#795).
      await expect(service.createEvent(retry)).resolves.toEqual({
        ...original,
        status: EventStatus.Completed,
        occurrences: [occurrence],
        attendees: [],
        policy,
      });
      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      // Only the replay's batch read: the create's interactive transaction never opens.
      expect(db.$transaction.mock.calls.every(([operations]) => Array.isArray(operations))).toBe(true);
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.event.create).not.toHaveBeenCalled();
    });

    it('looks the key up under the creator, with no `deletedAt` filter and nothing embedded', async () => {
      db.event.findUnique.mockResolvedValue(original);

      await service.createEvent(retry);

      // No `deletedAt` filter: the row is the create's outcome even after a
      // soft delete, and the client reconciles against it. Nothing embedded:
      // an `include` would hand the creator every attendee whatever they may
      // read now.
      expect(db.event.findUnique).toHaveBeenCalledWith({
        where: { createdById_clientRequestId: { createdById: 'user-1', clientRequestId: 'k' } },
      });
    });

    // A creator who has lost read on the event since, or a removed attendee,
    // must not come back from a retry the way `GET /events/:id` would refuse.
    it("reads the replay's parts under their own ceilings, in the create's shape, without removed attendees", async () => {
      db.event.findUnique.mockResolvedValue(original);

      await service.createEvent(retry);

      expect(compose).toHaveBeenCalledWith(ResourceType.EventOccurrence, Action.read, { eventId: 'event-1' });
      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({
        where: { eventId: 'event-1', AND: [COND] },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, {
        eventId: 'event-1',
        removedAt: null,
      });
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: { eventId: 'event-1', removedAt: null, AND: [COND] },
        include: EVENT_CREATE_INCLUDE.attendees.include,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.EventPolicy, Action.read);
      expect(db.eventPolicy.findUnique).toHaveBeenCalledWith({ where: { eventId: 'event-1', AND: [COND] } });
      expect(batchTransactionCall(db).options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });

    // Eviction is idempotent, and it heals an original that committed but
    // crashed before its own eviction ran. Whose graph is stale does not
    // depend on whom the creator may see, so the scoped read, empty here,
    // does not decide it. The retry's invitees were never added.
    it("evicts every attendee row's user on a replay, read unscoped, not the retry's invitees", async () => {
      db.event.findUnique.mockResolvedValue(original);

      await service.createEvent(retry);

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: { eventId: 'event-1' },
        select: { userId: true },
      });
      expect(permissions.invalidateUsers).toHaveBeenCalledWith(['user-1', 'user-3']);
    });

    // The abilities primed at the request's start can predate the host role:
    // the loser of a concurrent create primed before the winner committed it,
    // and a retry after a crash before the original's eviction read the stale
    // graph. Outside a household that role is the creator's only read on the
    // parts, so they must be read under abilities resolved after the eviction.
    it('evicts, then primes the abilities again, before it reads the parts', async () => {
      // One log across mocks from different factories, whose call counters
      // are not comparable.
      const steps: string[] = [];
      db.event.findUnique.mockResolvedValue(original);
      permissions.invalidateUsers.mockImplementation(async () => void steps.push('evict'));
      abilityService.primeCurrentActor.mockImplementation(async () => void steps.push('prime'));
      abilityService.getCurrentResourceConditions.mockImplementation((type) => {
        steps.push(`ceiling:${type}`);

        return [COND];
      });

      await service.createEvent(retry);

      expect(steps).toEqual([
        'evict',
        'prime',
        `ceiling:${ResourceType.EventOccurrence}`,
        `ceiling:${ResourceType.EventAttendee}`,
        `ceiling:${ResourceType.EventPolicy}`,
      ]);
    });

    it('primes the abilities again only on a replay', async () => {
      db.event.findUnique.mockResolvedValue(null);
      db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-2', createdById: 'user-1' })));

      await service.createEvent({ title: 'X', clientRequestId: 'k' } as CreateEventDto);

      expect(abilityService.primeCurrentActor).not.toHaveBeenCalled();
    });

    it('emits neither the created event nor its webhook on a replay, so no invitee is notified twice', async () => {
      db.event.findUnique.mockResolvedValue(original);

      await service.createEvent(retry);

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('logs a create, and not a replay, which made nothing', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      db.event.findUnique.mockResolvedValueOnce(original).mockResolvedValueOnce(null);
      db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-2', title: 'Fresh', createdById: 'user-1' })));

      await service.createEvent(retry);
      expect(log).not.toHaveBeenCalled();

      await service.createEvent({ title: 'Fresh', clientRequestId: 'k2' } as CreateEventDto);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('Event "Fresh" (event-2) created by user user-1');

      log.mockRestore();
    });

    it('replays the row a concurrent duplicate committed when its create trips the unique', async () => {
      db.event.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(original);
      db.$transaction.mockImplementation(((operations: unknown) =>
        Array.isArray(operations) ? Promise.all(operations) : Promise.reject(uniqueViolationWithoutMeta())) as never);

      await expect(
        service.createEvent({ title: 'Original', clientRequestId: 'k' } as CreateEventDto),
      ).resolves.toMatchObject({ id: 'event-1' });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('stores the key on a fresh create, and emits each event once', async () => {
      db.event.findUnique.mockResolvedValue(null);
      db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-2', createdById: 'user-1' })));

      await service.createEvent({ title: 'X', clientRequestId: 'k' } as CreateEventDto);

      expect(db.event.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientRequestId: 'k' }) }),
      );
      expect(emitter.emit.mock.calls.map(([name]) => name)).toEqual([
        EventCreatedEvent.eventName,
        WebhookEventType.EventCreated,
      ]);
    });

    // DTO validation never runs for an in-process caller, so the service
    // normalizes the key itself.
    it('reads a whitespace-only key as no key', async () => {
      db.event.create.mockResolvedValue(withDates(makeEvent({ id: 'event-2', createdById: 'user-1' })));

      await service.createEvent({ title: 'X', clientRequestId: '   ' } as CreateEventDto);

      expect(db.event.findUnique).not.toHaveBeenCalled();
      expect(db.event.create.mock.calls[0][0].data.clientRequestId).toBeUndefined();
    });

    it('trims a padded key, so it finds the event its unpadded twin made', async () => {
      db.event.findUnique.mockResolvedValue(original);

      await service.createEvent({ ...retry, clientRequestId: '  k  ' });

      expect(db.event.findUnique).toHaveBeenCalledWith({
        where: { createdById_clientRequestId: { createdById: 'user-1', clientRequestId: 'k' } },
      });
    });
  });
});
