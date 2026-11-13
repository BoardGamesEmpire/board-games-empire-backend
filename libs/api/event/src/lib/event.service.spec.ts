import type { Event } from '@bge/database';
import {
  Action,
  EventParticipationStatus,
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
import { DefaultPaginationQueryDto } from '@bge/shared';
import {
  batchTransactionCall,
  createMockAbilityService,
  createMockDatabaseService,
  createTestingModuleWithDb,
  makeEvent,
  makeEventOccurrence,
  makeEventPolicy,
  MOCK_ACTING_USER_ID,
  rawQueryText,
  unwrapTransaction,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { browseEventScope } from './browse-event-scope';
import { EVENT_CREATE_INCLUDE } from './constants/event-create-include.constant';
import type { CreateEventDto } from './dto/create-event.dto';
import { ListEventsQueryDto } from './dto/list-events.query.dto';
import { EventService } from './event.service';
import { EventCreatedEvent, EventDeletedEvent, EventUpdatedEvent } from './events/event.events';
import { EVENT_ATTENDANCE_SELECT } from './utils/event-attendance.util';
import { EVENT_STATUS_DATE_SELECT } from './utils/event-status.util';
import { upcomingDateWhere, upcomingEventWhere } from './utils/upcoming-events.util';

const COND = { id: 'sentinel-condition' };

const OWN_RSVP_DATE = new Date('2026-10-30T12:00:00Z');

/** The acting user's attendee row on an event, as the attendance read selects it (#867). */
const ownAttendeeRow = (eventId: string) => ({
  id: `attendee-${eventId}`,
  eventId,
  status: EventParticipationStatus.Attending,
  rsvpDate: OWN_RSVP_DATE,
  role: { role: { name: 'EventHost' } },
});

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
      unwrapTransaction(db);
      db.event.findMany.mockResolvedValue([]);
      db.event.count.mockResolvedValue(0);
      db.eventAttendee.findMany.mockResolvedValue([]);
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

      // Interactive, because the attendance read needs the page's ids (#867).
      const [operations, options] = db.$transaction.mock.calls[0] as unknown as [unknown, unknown];
      expect(operations).toEqual(expect.any(Function));
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    /**
     * #867. Each row says how the acting user attends. The ceiling goes in the read's
     * top-level `where`, the only place a deny-all ceiling is enforced (#559).
     */
    it("reads the acting user's own attendee rows on the page, under the attendee ceiling (#867)", async () => {
      db.event.findMany.mockResolvedValue([
        { ...makeEvent({ id: 'event-1' }), occurrences: [] },
        { ...makeEvent({ id: 'event-2' }), occurrences: [] },
      ] as never);

      await read();

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, {
        userId: MOCK_ACTING_USER_ID,
        removedAt: null,
        eventId: { in: ['event-1', 'event-2'] },
      });
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: {
          userId: MOCK_ACTING_USER_ID,
          removedAt: null,
          eventId: { in: ['event-1', 'event-2'] },
          AND: [COND],
        },
        select: EVENT_ATTENDANCE_SELECT,
      });
    });

    it('gives each row its own attendance, and null where the read found none (#867)', async () => {
      db.event.findMany.mockResolvedValue([
        { ...makeEvent({ id: 'event-1' }), occurrences: [] },
        { ...makeEvent({ id: 'event-2' }), occurrences: [] },
      ] as never);
      db.eventAttendee.findMany.mockResolvedValue([ownAttendeeRow('event-2')] as never);

      const { rows } = await read();

      expect(rows.map(({ id, attendance }) => ({ id, attendance }))).toEqual([
        { id: 'event-1', attendance: null },
        {
          id: 'event-2',
          attendance: {
            attendeeId: 'attendee-event-2',
            status: EventParticipationStatus.Attending,
            role: 'EventHost',
            rsvpDate: OWN_RSVP_DATE,
          },
        },
      ]);
    });

    it('makes no attendee read for an empty page (#867)', async () => {
      await read();

      expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
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
   * #962. The upcoming events the acting user can read and has no attendee row
   * on. The list declares its own set, the browse scope, so elevated users are
   * listed the same kind of set as everyone, and the ceiling only limits it
   * (#512, #365).
   * The paging itself is `pageUpcomingEvents`', pinned in its own spec.
   */
  describe('browseEvents (#962)', () => {
    const NOW = new Date('2026-11-01T12:00:00Z');
    let groupBy: jest.Mock;

    const browse = (init: Record<string, unknown> = {}) =>
      service.browseEvents(
        plainToInstance(DefaultPaginationQueryDto, { limit: 20, ...init }, { enableImplicitConversion: true }),
      );

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
      unwrapTransaction(db);
      groupBy = db.eventOccurrence.groupBy as unknown as jest.Mock;
      groupBy.mockResolvedValue([]);
      db.event.count.mockResolvedValue(0);
    });

    afterEach(() => jest.useRealTimers());

    it('asks the composer for its where clause, declaring the browse scope', async () => {
      await browse();

      expect(compose).toHaveBeenCalledWith(ResourceType.Event, Action.read, browseEventScope(MOCK_ACTING_USER_ID));
    });

    // Asking is not enough: the page has to use the answer. The ceiling stays
    // ANDed in, because for an `apiKey` actor it carries the key ∩ owner floor.
    it('pages through the composed clause, the ceiling limiting it rather than supplying it', async () => {
      await browse({ page: 2 });

      const composed = { ...browseEventScope(MOCK_ACTING_USER_ID), AND: [COND] };
      const upcoming = { AND: [upcomingEventWhere(NOW), composed] };
      const standing = { AND: [{ deletedAt: null, cancelledAt: null, archivedAt: null }, composed] };
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.read);
      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...upcomingDateWhere(NOW), event: { is: standing } }, skip: 20, take: 20 }),
      );
      expect(db.event.count).toHaveBeenCalledWith({ where: upcoming });
    });

    // #867. The scope leaves out every event the acting user has a row on, so this
    // read finds nothing, and a row says so with `null` rather than no field.
    it('gives an upcoming row null attendance, through the same read as the other lists (#867)', async () => {
      groupBy.mockResolvedValue([{ eventId: 'event-1' }]);
      db.event.findMany.mockResolvedValue([{ ...makeEvent({ id: 'event-1' }), occurrences: [futureDate()] }] as never);
      db.eventAttendee.findMany.mockResolvedValue([]);

      const { rows } = await browse();

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, {
        userId: MOCK_ACTING_USER_ID,
        removedAt: null,
        eventId: { in: ['event-1'] },
      });
      expect(rows.map(({ id, attendance }) => ({ id, attendance }))).toEqual([{ id: 'event-1', attendance: null }]);
    });

    // PROVISIONAL (#395), as on `GET /events`: "the events I could join" has
    // no meaning for an actor with no user behind it, and an empty page would
    // tell a client there are none.
    it('refuses an actor kind with no user behind it rather than answering an empty page', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await browse().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(groupBy).not.toHaveBeenCalled();
    });
  });

  /**
   * #506. A household's upcoming events, whoever is asking. The scope also
   * checks the household, because the liveness guard passes an actor who can't
   * read `Household` and a soft delete leaves its events live (#992).
   */
  describe('getHouseholdEvents (#506)', () => {
    const NOW = new Date('2026-11-01T12:00:00Z');
    const SCOPE = { householdId: 'household-1', household: { is: { deletedAt: null } } };
    let groupBy: jest.Mock;

    const list = (init: Record<string, unknown> = {}) =>
      service.getHouseholdEvents(
        'household-1',
        plainToInstance(DefaultPaginationQueryDto, { limit: 20, ...init }, { enableImplicitConversion: true }),
      );

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
      unwrapTransaction(db);
      groupBy = db.eventOccurrence.groupBy as unknown as jest.Mock;
      groupBy.mockResolvedValue([]);
      db.event.count.mockResolvedValue(0);
      db.eventAttendee.findMany.mockResolvedValue([]);
    });

    afterEach(() => jest.useRealTimers());

    it('asks the composer for its where clause, naming the household and that it is live', async () => {
      await list();

      expect(compose).toHaveBeenCalledWith(ResourceType.Event, Action.read, SCOPE);
    });

    it('pages through the composed clause, the ceiling limiting it rather than supplying it', async () => {
      await list({ page: 2 });

      const composed = { ...SCOPE, AND: [COND] };
      const standing = { AND: [{ deletedAt: null, cancelledAt: null, archivedAt: null }, composed] };
      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...upcomingDateWhere(NOW), event: { is: standing } }, skip: 20, take: 20 }),
      );
      expect(db.event.count).toHaveBeenCalledWith({ where: { AND: [upcomingEventWhere(NOW), composed] } });
    });

    it("reads the acting user's own attendee rows on the page (#867)", async () => {
      groupBy.mockResolvedValue([{ eventId: 'event-1' }]);
      db.event.findMany.mockResolvedValue([{ ...makeEvent({ id: 'event-1' }), occurrences: [futureDate()] }] as never);
      db.eventAttendee.findMany.mockResolvedValue([ownAttendeeRow('event-1')] as never);

      const { rows } = await list();

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, {
        userId: MOCK_ACTING_USER_ID,
        removedAt: null,
        eventId: { in: ['event-1'] },
      });
      expect(rows[0].attendance?.attendeeId).toBe('attendee-event-1');
    });

    // This route isn't first-person: the household names the set, so an actor
    // with no user gets the same list rather than a refusal, as on
    // `users/:userId/game-collections` (#514). A where on `userId: null` would
    // match the rows of attendees with no account, so it makes no attendance read.
    it('lists for an actor with no user, with null attendance and no attendee read', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });
      groupBy.mockResolvedValue([{ eventId: 'event-1' }]);
      db.event.findMany.mockResolvedValue([{ ...makeEvent({ id: 'event-1' }), occurrences: [futureDate()] }] as never);

      const { rows } = await list();

      expect(rows.map(({ id, attendance }) => ({ id, attendance }))).toEqual([{ id: 'event-1', attendance: null }]);
      expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
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
        attendance: null,
      });
    });

    /**
     * #867. The acting user's own row is a read of its own rather than a search of
     * `attendees`, because #404 may cap that embed and a search would then give
     * some attendees `null`.
     */
    it("reads the acting user's own attendee row under the attendee ceiling, and serves it (#867)", async () => {
      db.eventAttendee.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([ownAttendeeRow('event-1')] as never);

      const detail = await service.getEventById('event-1');

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, {
        userId: MOCK_ACTING_USER_ID,
        removedAt: null,
        eventId: { in: ['event-1'] },
      });
      expect(db.eventAttendee.findMany).toHaveBeenLastCalledWith({
        where: { userId: MOCK_ACTING_USER_ID, removedAt: null, eventId: { in: ['event-1'] }, AND: [COND] },
        select: EVENT_ATTENDANCE_SELECT,
      });
      expect(detail.attendance).toEqual({
        attendeeId: 'attendee-event-1',
        status: EventParticipationStatus.Attending,
        role: 'EventHost',
        rsvpDate: OWN_RSVP_DATE,
      });
    });

    it('gives an acting user with no row of their own null attendance (#867)', async () => {
      const detail = await service.getEventById('event-1');

      expect(detail.attendance).toBeNull();
    });

    // `EventAttendee.userId` is nullable, so a where on `userId: null` would
    // match the row of an attendee with no account and hand a plugin a stranger's
    // attendance. `GET /events/:id` admits actors with no user, so the read is
    // skipped.
    it('makes no attendance read for an actor with no user, whose where would match attendees with no account (#867)', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const detail = await service.getEventById('event-1');

      expect(detail.attendance).toBeNull();
      expect(db.eventAttendee.findMany).toHaveBeenCalledTimes(1);
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1', removedAt: null, AND: [COND] } }),
      );
      expect(batchTransactionCall(db).operations).toHaveLength(5);
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

    it('takes the six reads from one REPEATABLE READ snapshot', async () => {
      await service.getEventById('event-1');

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(6);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    it('throws NotFound when the event is not visible', async () => {
      db.event.findUnique.mockResolvedValue(null);
      await expect(service.getEventById('event-1')).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * #731. Both writes take the event's row FOR NO KEY UPDATE first and read
   * the row again under the lock, as the lifecycle transitions do (#795). A
   * write that loses a race to a delete then finds the row deleted and answers
   * 404, as a request arriving after the delete would.
   */
  describe('updateEvent and deleteEvent under the event row lock (#731)', () => {
    /** The transaction's client, apart from `db`, so a write outside the transaction can't pass for one inside it. */
    let tx: MockDatabaseService;

    /** The row the lock-then-read finds. */
    let row: Event | null;

    const dependentRecordNotFound = () =>
      new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
        code: 'P2025',
        clientVersion: 'test',
      });

    beforeEach(() => {
      tx = createMockDatabaseService();
      db.$transaction.mockImplementation((async (callback: (client: MockDatabaseService) => Promise<unknown>) => {
        const result = await callback(tx);

        // Nothing is told of a change before it commits.
        expect(emitter.emit).not.toHaveBeenCalled();

        return result;
      }) as never);

      // A read outside the transaction would find the event live, as a
      // request that loses the race found it before it queued. So only a read
      // under the lock can answer 404 or give the before-snapshot.
      db.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', title: 'Read before the lock' }));
      db.event.count.mockResolvedValue(1);

      row = makeEvent({ id: 'event-1' });
      tx.$queryRaw.mockResolvedValue([]);
      tx.event.findUnique.mockImplementation((() => Promise.resolve(row)) as never);
      // The caller's update ceiling reaches the event.
      tx.event.count.mockResolvedValue(1);
      tx.event.update.mockImplementation(((args: { data: Partial<Event> }) =>
        Promise.resolve(withDates({ ...(row as Event), ...args.data }))) as never);
    });

    describe.each([
      {
        name: 'updateEvent',
        run: () => service.updateEvent('event-1', { title: 'New' } as never),
        forbidden: () => t('common.forbidden.update'),
      },
      {
        name: 'deleteEvent',
        run: () => service.deleteEvent('event-1'),
        forbidden: () => t('common.forbidden.delete'),
      },
    ])('$name', ({ run, forbidden }) => {
      it('locks the event row FOR NO KEY UPDATE before reading it', async () => {
        await run();

        const [[lock]] = tx.$queryRaw.mock.calls;
        expect(rawQueryText(lock)).toMatch(/^SELECT id FROM events WHERE id = \? FOR NO KEY UPDATE$/);
        expect((lock as Prisma.Sql).values).toEqual(['event-1']);
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.event.findUnique.mock.invocationCallOrder[0]);
        expect(tx.event.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
          tx.event.update.mock.invocationCallOrder[0],
        );
      });

      it('answers 404 for an event deleted before the lock was granted, and writes nothing', async () => {
        row = makeEvent({ id: 'event-1', deletedAt: new Date() });

        await expect(run()).rejects.toThrow(new NotFoundException(t('errors.event.not_found', { id: 'event-1' })));
        expect(tx.event.update).not.toHaveBeenCalled();
        expect(db.event.update).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      // A household delete removes its events' rows outright.
      it('answers 404 when the row is gone', async () => {
        row = null;

        await expect(run()).rejects.toThrow(new NotFoundException(t('errors.event.not_found', { id: 'event-1' })));
        expect(tx.event.update).not.toHaveBeenCalled();
      });

      // The write repeats what the read under the lock found, so a write that
      // finds no row was refused by the ceiling alone.
      it('requires the event still live in the write, beside the ceiling', async () => {
        await run();

        expect(tx.event.update).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'event-1', deletedAt: null, AND: [COND] } }),
        );
      });

      it('still answers 403 when the ceiling refuses the live row', async () => {
        tx.event.update.mockRejectedValue(dependentRecordNotFound());

        await expect(run()).rejects.toThrow(new ForbiddenException(forbidden()));
        expect(emitter.emit).not.toHaveBeenCalled();
      });
    });

    // A PATCH queued behind another write records the state that write left.
    it('updateEvent takes the audit before-snapshot from the row read under the lock', async () => {
      row = makeEvent({ id: 'event-1', title: 'Locked read' });

      await service.updateEvent('event-1', { title: 'New' } as never);

      const [, emitted] = emitter.emit.mock.calls.find(([name]) => name === EventUpdatedEvent.eventName) ?? [];
      expect(emitted?.before).toEqual({ id: 'event-1', title: 'Locked read' });
    });

    it('updateEvent → update', async () => {
      row = makeEvent({ id: 'event-1', title: 'Old' });
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New' })));

      await service.updateEvent('event-1', { title: 'New' } as never);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.update);
      expect(tx.event.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'event-1', AND: [COND] }) }),
      );
    });

    // The answer used to carry the policy row whole (`include.policy`), which a
    // writer who may update the event but not read its policy would then see.
    it('reads the policy it answers with under the policy read ceiling (#796)', async () => {
      const policy = makeEventPolicy('event-1');
      tx.eventPolicy.findUnique.mockResolvedValue(policy);

      const updated = await service.updateEvent('event-1', { title: 'New' } as never);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.EventPolicy, Action.read);
      expect(tx.eventPolicy.findUnique).toHaveBeenCalledWith({ where: { eventId: 'event-1', AND: [COND] } });
      expect(tx.event.update.mock.calls[0][0].include).not.toHaveProperty('policy');
      expect(tx.event.update.mock.invocationCallOrder[0]).toBeLessThan(
        tx.eventPolicy.findUnique.mock.invocationCallOrder[0],
      );
      expect(updated.policy).toEqual(policy);
    });

    it('answers a null policy when the ceiling hides it, and the write still lands (#796)', async () => {
      tx.eventPolicy.findUnique.mockResolvedValue(null);

      const updated = await service.updateEvent('event-1', { title: 'New' } as never);

      expect(tx.event.update).toHaveBeenCalled();
      expect(updated.policy).toBeNull();
    });

    it('updateEvent emits an EventUpdatedEvent carrying the changed subset', async () => {
      row = makeEvent({ id: 'event-1', title: 'Old' });
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New' })));

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
      row = makeEvent({ id: 'event-1', title: 'Old', householdId: 'hh-1' });
      tx.event.update.mockResolvedValue(
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
      row = makeEvent({ id: 'event-1', title: 'Old', location: 'Same Hall' });
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New', location: 'Same Hall' })));

      await service.updateEvent('event-1', { title: 'New', location: 'Same Hall' } as never);

      const [, sent] = emitter.emit.mock.calls.find(([name]) => name === WebhookEventType.EventUpdated) ?? [];
      expect(sent?.data.changedFields).toEqual(['title']);
    });

    it('writes no audit event when the patch re-sends stored values (#728)', async () => {
      row = makeEvent({ id: 'event-1', title: 'Same', location: 'Hall' });
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'Same', location: 'Hall' })));

      await service.updateEvent('event-1', { title: 'Same', location: 'Hall' } as never);

      expect(emitter.emit).not.toHaveBeenCalledWith(EventUpdatedEvent.eventName, expect.anything());
    });

    it('audits only the changed column when one of two sent changed (#728)', async () => {
      row = makeEvent({ id: 'event-1', title: 'Old', location: 'Hall' });
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New', location: 'Hall' })));

      await service.updateEvent('event-1', { title: 'New', location: 'Hall' } as never);

      const [, emitted] = emitter.emit.mock.calls.find(([name]) => name === EventUpdatedEvent.eventName) ?? [];
      expect(Object.keys(emitted.before)).toEqual(['id', 'title']);
      expect(Object.keys(emitted.after)).toEqual(['id', 'title']);
    });

    it('updateEvent sends no webhook when the patch changes no value', async () => {
      // A form that re-sends what it loaded would otherwise post "updated" to
      // every subscriber for a change that never happened.
      row = makeEvent({ id: 'event-1', title: 'Same' });
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'Same' })));

      await service.updateEvent('event-1', { title: 'Same' } as never);

      expect(emitter.emit).not.toHaveBeenCalledWith(WebhookEventType.EventUpdated, expect.anything());
    });

    // From the dates the update reads back, with no read after the commit: a
    // failed one would report a patch that happened as one that didn't.
    it('updateEvent serves the status worked out from the dates it reads back (#795)', async () => {
      row = makeEvent({ id: 'event-1', title: 'Old' });
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'New' }), [futureDate()]));

      const updated = await service.updateEvent('event-1', { title: 'New' } as never);

      expect(tx.eventOccurrence.findMany).not.toHaveBeenCalled();
      expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
      expect(updated.status).toBe(EventStatus.Scheduled);
    });

    describe('a switch to Fixed (#796)', () => {
      it('refuses a switch to Fixed while two dates are live (#796)', async () => {
        row = makeEvent({ id: 'event-1', schedulingMode: EventSchedulingMode.MultiDay });
        tx.eventOccurrence.count.mockResolvedValue(2);

        await expect(
          service.updateEvent('event-1', { schedulingMode: EventSchedulingMode.Fixed } as never),
        ).rejects.toMatchObject({
          response: { code: 'EVENT_FIXED_MODE_TOO_MANY_DATES' },
          status: 400,
        });

        expect(tx.eventOccurrence.count).toHaveBeenCalledWith({
          where: { eventId: 'event-1', status: { in: [OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed] } },
        });
        expect(tx.event.update).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('allows a switch to Fixed with one live date and any number of cancelled ones (#796)', async () => {
        row = makeEvent({ id: 'event-1', schedulingMode: EventSchedulingMode.MultiDay });
        tx.eventOccurrence.count.mockResolvedValue(1);

        await service.updateEvent('event-1', { schedulingMode: EventSchedulingMode.Fixed } as never);

        expect(tx.event.update).toHaveBeenCalled();
      });

      it('counts the dates under the lock, after the grant is checked and before the update (#796)', async () => {
        row = makeEvent({ id: 'event-1', schedulingMode: EventSchedulingMode.Poll });
        tx.eventOccurrence.count.mockResolvedValue(1);

        await service.updateEvent('event-1', { schedulingMode: EventSchedulingMode.Fixed } as never);

        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.event.count.mock.invocationCallOrder[0]);
        expect(tx.event.count.mock.invocationCallOrder[0]).toBeLessThan(
          tx.eventOccurrence.count.mock.invocationCallOrder[0],
        );
        expect(tx.eventOccurrence.count.mock.invocationCallOrder[0]).toBeLessThan(
          tx.event.update.mock.invocationCallOrder[0],
        );
      });

      // The route's guard passes anyone holding update:event on any event. The
      // grant is checked against this event's row before the dates are
      // counted, so a caller it doesn't reach gets 403, never a 400 that tells
      // them how many live dates this event has (#796).
      it('answers 403 to a caller outside the update ceiling before counting the dates (#796)', async () => {
        row = makeEvent({ id: 'event-1', schedulingMode: EventSchedulingMode.MultiDay });
        tx.event.count.mockResolvedValue(0);
        tx.eventOccurrence.count.mockResolvedValue(2);

        await expect(
          service.updateEvent('event-1', { schedulingMode: EventSchedulingMode.Fixed } as never),
        ).rejects.toThrow(new ForbiddenException(t('common.forbidden.update')));

        expect(tx.event.count).toHaveBeenCalledWith({ where: { id: 'event-1', AND: [COND] } });
        expect(tx.eventOccurrence.count).not.toHaveBeenCalled();
        expect(tx.event.update).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it.each([
        ['the mode is unchanged', EventSchedulingMode.Fixed, { schedulingMode: EventSchedulingMode.Fixed }],
        ['the switch is to another mode', EventSchedulingMode.Fixed, { schedulingMode: EventSchedulingMode.Poll }],
        ['the patch leaves the mode alone', EventSchedulingMode.MultiDay, { title: 'New' }],
      ])('does not count dates when %s', async (_name, stored, patch) => {
        row = makeEvent({ id: 'event-1', schedulingMode: stored });

        await service.updateEvent('event-1', patch as never);

        expect(tx.eventOccurrence.count).not.toHaveBeenCalled();
        expect(tx.event.update).toHaveBeenCalled();
      });
    });

    it('rejects an empty update patch', async () => {
      await expect(service.updateEvent('event-1', {} as never)).rejects.toThrow(BadRequestException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('deleteEvent → delete (soft)', async () => {
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1' })));

      await service.deleteEvent('event-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Event, Action.delete);
      expect(tx.event.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
      );
    });

    it('deleteEvent emits an EventDeletedEvent (before-only)', async () => {
      abilityService.getActingUserId.mockReturnValue('user-1');
      tx.event.update.mockResolvedValue(
        withDates(makeEvent({ id: 'event-1', title: 'Doomed', createdById: 'user-1' })),
      );

      await service.deleteEvent('event-1');

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(EventDeletedEvent.eventName);
      expect(emitted).toBeInstanceOf(EventDeletedEvent);
      expect(emitted.action).toBe('delete');
      expect(emitted.subjectId).toBe('event-1');
      expect(emitted.before).toEqual(expect.objectContaining({ id: 'event-1', title: 'Doomed' }));
      expect(emitted.after).toBeNull();
      expect(emitted.actingUserId).toBe('user-1');
    });

    it('deleteEvent sends event.event.deleted.v1 with ids only, keyed on the event', async () => {
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1', title: 'Doomed', householdId: null })));

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

    // The dates ride on the delete's own update, inside the transaction that
    // holds the event's row lock, so no date write commits between the delete
    // and the read, and a failed read rolls the delete back.
    it('deleteEvent serves the status the event had from the dates its update reads back (#795)', async () => {
      tx.event.update.mockResolvedValue(withDates(makeEvent({ id: 'event-1' }), [futureDate()]));

      const deleted = await service.deleteEvent('event-1');

      expect(deleted).toEqual(expect.objectContaining({ id: 'event-1', status: EventStatus.Scheduled }));
      expect(deleted).not.toHaveProperty('occurrences');
      expect(tx.event.update).toHaveBeenCalledWith(
        expect.objectContaining({ include: { occurrences: { select: EVENT_STATUS_DATE_SELECT } } }),
      );
      expect(tx.eventOccurrence.findMany).not.toHaveBeenCalled();
      expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
    });
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

    // The settings PATCH doesn't offer the extended network as a policy
    // (#497). Stored by a write that skips it, the policy lets nobody in, a
    // friend included.
    it('refuses every invite under an ExtendedNetwork event policy, which no route accepts but a direct write could store (#497)', async () => {
      db.systemSetting.findUnique.mockResolvedValue({
        householdInviteePolicy: Reach.Public,
        eventInviteePolicy: Reach.ExtendedNetwork,
      } as never);
      db.friendship.findFirst.mockResolvedValue({ status: FriendshipStatus.Accepted } as never);

      const error = await service
        .createEvent({ title: 'X', inviteUserIds: ['user-2'] } as CreateEventDto)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).message).toContain('errors.event.invitee_friends_only');
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

    // A cancel that commits between the key lookup and the parts must not
    // pair the lookup's uncancelled row with the cancel's dates, which would
    // read Planning: a status the event had neither before nor after (#795).
    it("answers with the row read again in the parts' snapshot, its status from the same snapshot's dates", async () => {
      const cancelled = { ...original, cancelledAt: new Date('2026-10-27T00:00:00Z') };
      db.event.findUnique.mockResolvedValueOnce(original).mockResolvedValueOnce(cancelled);

      await expect(service.createEvent(retry)).resolves.toEqual(
        expect.objectContaining({ cancelledAt: cancelled.cancelledAt, status: EventStatus.Cancelled }),
      );
      expect(db.event.findUnique).toHaveBeenLastCalledWith({ where: { id: 'event-1' } });
      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({
        where: { eventId: 'event-1' },
        select: { status: true, startDate: true, endDate: true },
      });
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
