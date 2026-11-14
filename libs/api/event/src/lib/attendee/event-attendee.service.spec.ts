import type { Event, EventAttendee, EventGame, GameCollection } from '@bge/database';
import {
  Action,
  EventParticipationStatus,
  FriendshipStatus,
  HUMAN_USER_WHERE,
  NominationStatus,
  Prisma,
  Reach,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEventAttendee,
  makeEventAttendeeGameList,
  MOCK_ACTING_USER_ID,
  paginationQuery,
  rawQueryText,
  unwrapTransaction,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ATTENDEE_USER_AND_ROLE_INCLUDE } from '../constants/attendee-user-and-role.constant';
import {
  GameRemovedFromEventEvent,
  NominationPausedEvent,
  NominationResumedEvent,
} from '../nomination/events/nomination.events';
import { makeOfferedGameEntry } from '../offered-game/offered-game.fixture';
import { OFFERED_GAME_ORDER, OFFERED_GAME_SELECT } from '../offered-game/offered-game.select';
import { OfferedGameService } from '../offered-game/offered-game.service';
import { lineupStillAhead } from './attendance';
import { EventAttendeeService } from './event-attendee.service';
import {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
  GameAddedToListEvent,
  GameRemovedFromListEvent,
} from './events/attendee.events';
import { OfferRefusal } from './offer-outcome';

const COND = { id: 'sentinel-condition' };

describe('EventAttendeeService', () => {
  let service: EventAttendeeService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser'>>;
  let emitter: { emit: jest.Mock };
  let compose: jest.SpyInstance;
  let forAttendees: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    permissions = { invalidateUser: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventAttendeeService,
        // The REAL offered-game reads, so the selects and scopes asserted
        // below are the ones the attendee routes run (#1187).
        OfferedGameService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the reads actually run.
        ScopeComposer,
        { provide: EventEmitter2, useValue: emitter },
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventAttendeeService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
    forAttendees = jest.spyOn(ctx.module.get(OfferedGameService), 'forAttendees');

    // The writes run their statements on the transaction client; the mock
    // hands the callback the same delegates. The paged list read (#373) is the
    // array form, which resolves positionally. Nothing is supplied from the
    // attendee's list unless a test says so.
    unwrapTransaction(db);
    db.eventGameNomination.updateManyAndReturn.mockResolvedValue([]);
    db.eventGame.findMany.mockResolvedValue([]);
    // No attendee offers a game, and no offered game has base games or open
    // nominations, unless a test says so (#1187).
    db.eventAttendeeGameList.findMany.mockResolvedValue([]);
    db.gameExpansion.findMany.mockResolvedValue([]);
    // Each offered game also reads the acting user's wishlist (#1241).
    db.listEntry.findMany.mockResolvedValue([]);
    db.eventGameNomination.findMany.mockResolvedValue([]);
    // Every user an add names is a person unless a test says otherwise. The
    // invite checks' other reads find no row: the default policy and
    // preference, and no friendship.
    db.user.findUnique.mockImplementation(((args: { where: { id: string } }) =>
      Promise.resolve({ id: args.where.id })) as never);
  });

  /** The status write's row: an attendee of event-1 who has not been removed. */
  const attendeeRow = (overrides: Partial<EventAttendee> = {}) =>
    makeEventAttendee({ id: 'att-1', eventId: 'event-1', userId: 'user-1', ...overrides });

  /**
   * The status an RSVP's transaction reads under the attendee row's lock, as
   * the status it replaces (#802). Every other raw query resolves no rows, as
   * the mock's default does.
   */
  const lockedStatus = (status: EventParticipationStatus, removedAt: Date | null = null) =>
    lockedAttendee({ status, removedAt });

  /**
   * The attendee row a write reads under its lock (#802, #1064), or none when
   * `row` is null. Every other raw query resolves no rows.
   */
  const lockedAttendee = (row: object | null) =>
    db.$queryRaw.mockImplementation(((query: unknown) =>
      Promise.resolve(/FROM event_attendees/.test(rawQueryText(query)) && row ? [row] : [])) as never);

  const recordNotFound = () =>
    new Prisma.PrismaClientKnownRequestError('No record was found', { code: 'P2025', clientVersion: 'test' });

  afterEach(() => jest.clearAllMocks());

  describe('EventAttendee resource', () => {
    // #512. A collection read, and composes like one; since #373 pages it, the
    // envelope guard stands behind it too. The rows do not change: the path's
    // event was already the filter, and the ceiling still clips it.
    it('getAttendees asks the composer for its where clause, declaring the path event as its scope', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);

      await service.getAttendees('event-1', paginationQuery({ limit: 10 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, {
        eventId: 'event-1',
        removedAt: null,
      });
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1', removedAt: null, AND: [COND] } }),
      );
    });

    // Attendees added together can share a `createdAt`; `id` keeps their order
    // the same between requests, and the same as the event detail's.
    it('getAttendees lists them in the order they joined, with id breaking ties', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);

      await service.getAttendees('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      );
    });

    // #373 pages a read that used to return every attendee of the event.
    it('getAttendees takes one page rather than the whole event', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);

      await service.getAttendees('event-1', paginationQuery({ page: 2, limit: 5 }));

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5, skip: 5 }));
    });

    // A count through any other where, or outside the rows' snapshot, lets
    // `totalPages` promise a page that comes back short (#373).
    it('getAttendees counts through the same where as the rows, removed attendees excluded, in one REPEATABLE READ transaction', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);
      db.eventAttendee.count.mockResolvedValue(7);

      const page = await service.getAttendees('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventAttendee.count).toHaveBeenCalledWith({
        where: { eventId: 'event-1', removedAt: null, AND: [COND] },
      });
      expect(page).toEqual({ rows: [], total: 7 });

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // Paging must not turn a missing event into an empty page (#373): the
    // probe runs first, and outside the read's transaction.
    it('getAttendees throws NotFound for an event that does not exist, before any transaction', async () => {
      db.event.count.mockResolvedValue(0);

      await expect(service.getAttendees('missing', paginationQuery({ limit: 10 }))).rejects.toThrow(NotFoundException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('getAttendeeByUserId → read', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1' } as EventAttendee);

      await service.getAttendeeByUserId('event-1', 'user-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read);
    });

    it('addAttendee emits an AttendeeAddedEvent with the created row snapshot', async () => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
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

    // An organizer's or moderator's delete names the roles they may remove,
    // so this clause is what refuses them the host's row.
    describe('removeAttendee', () => {
      const removedAt = new Date('2026-10-15T12:00:00Z');

      beforeEach(() => {
        db.event.count.mockResolvedValue(1);
        db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
        db.eventAttendee.update.mockResolvedValue({ id: 'att-1' } as EventAttendee);
        db.eventAttendee.findUniqueOrThrow.mockResolvedValue(attendeeRow({ removedAt }));
        lockedAttendee({ removedAt: null });
      });

      it('reads the row again under its lock, before the gated write (#1064)', async () => {
        await service.removeAttendee('event-1', 'att-1');

        const [[attendeeLock]] = db.$queryRaw.mock.calls;
        expect(rawQueryText(attendeeLock)).toMatch(
          /^SELECT removed_at AS "removedAt" FROM event_attendees WHERE id = \? AND event_id = \? FOR NO KEY UPDATE$/,
        );
        expect((attendeeLock as unknown as Prisma.Sql).values).toEqual(['att-1', 'event-1']);
        expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          db.eventAttendee.update.mock.invocationCallOrder[0],
        );
      });

      // Another removal committed between the first read and the lock: the
      // attendee is gone, so the answer is 404, not the refusal (403) the
      // update matching nothing would read as.
      it('answers 404 when the attendee is removed by the time the lock is held (#1064)', async () => {
        lockedAttendee({ removedAt: new Date() });
        db.eventAttendee.update.mockRejectedValue(recordNotFound());

        await expect(service.removeAttendee('event-1', 'att-1')).rejects.toThrow(NotFoundException);
        expect(db.eventAttendee.update).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('answers 404 when the row is gone by the time the lock is held (#1064)', async () => {
        lockedAttendee(null);
        db.eventAttendee.update.mockRejectedValue(recordNotFound());

        await expect(service.removeAttendee('event-1', 'att-1')).rejects.toThrow(NotFoundException);
        expect(db.eventAttendee.update).not.toHaveBeenCalled();
      });

      // The row is there and not removed under the lock, so a write that
      // matches nothing is the delete conditions refusing it.
      it('still answers 403 when the delete conditions refuse the write after the locked read (#1064)', async () => {
        db.eventAttendee.update.mockRejectedValue(recordNotFound());

        await expect(service.removeAttendee('event-1', 'att-1')).rejects.toThrow(ForbiddenException);
      });

      // The row stays, so the nominations and votes it made keep their
      // author. Marking it removed is the write the route gate binds: an
      // organizer's or moderator's delete names the roles they may remove, so
      // this clause is what refuses them the host's row.
      it('marks the row removed, under the delete conditions, instead of deleting it', async () => {
        await service.removeAttendee('event-1', 'att-1');

        expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
          ResourceType.EventAttendee,
          Action.delete,
        );
        expect(db.eventAttendee.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'att-1', removedAt: null, AND: [COND] },
            data: { removedAt: expect.any(Date) },
          }),
        );
        expect(db.eventAttendee.delete).not.toHaveBeenCalled();
      });

      // Event grants render only from the attendee's role, so deleting it is
      // what takes the event off the removed user's ability surface.
      it('deletes their role after the gated write, which reads it', async () => {
        await service.removeAttendee('event-1', 'att-1');

        expect(db.eventAttendeeRole.deleteMany).toHaveBeenCalledWith({ where: { eventAttendeeId: 'att-1' } });
        expect(db.eventAttendee.update.mock.invocationCallOrder[0]).toBeLessThan(
          db.eventAttendeeRole.deleteMany.mock.invocationCallOrder[0],
        );
      });

      it('answers 404 for an attendee already removed, and writes nothing', async () => {
        db.eventAttendee.findUnique.mockResolvedValue(null);

        await expect(service.removeAttendee('event-1', 'att-1')).rejects.toThrow(NotFoundException);
        expect(db.eventAttendee.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'att-1', eventId: 'event-1', removedAt: null } }),
        );
        expect(db.eventAttendee.update).not.toHaveBeenCalled();
      });

      it('emits an AttendeeRemovedEvent as an update of removedAt', async () => {
        abilityService.getActingUserId.mockReturnValue('user-host');
        await service.removeAttendee('event-1', 'att-1');

        const [name, emitted] = emitter.emit.mock.calls[0];
        expect(name).toBe(AttendeeRemovedEvent.eventName);
        expect(emitted).toBeInstanceOf(AttendeeRemovedEvent);
        expect(emitted.action).toBe('update');
        expect(emitted.subjectId).toBe('att-1');
        expect(emitted.before).toEqual(expect.objectContaining({ id: 'att-1', eventId: 'event-1', removedAt: null }));
        expect(emitted.after).toEqual(expect.objectContaining({ id: 'att-1', eventId: 'event-1', removedAt }));
        expect(emitted.actingUserId).toBe('user-host');
      });

      // A removed attendee is out of the event, as one not attending is.
      it('pauses the nominations supplied from their list and deletes their scheduled games', async () => {
        db.eventGameNomination.updateManyAndReturn.mockImplementation((async (args: {
          where: { status: NominationStatus };
        }) => (args.where.status === NominationStatus.Open ? [{ id: 'nom-1' }] : [])) as never);
        db.eventGame.findMany.mockResolvedValue([{ id: 'eg-1' } as EventGame]);

        await service.removeAttendee('event-1', 'att-1');

        expect(db.eventGameNomination.updateManyAndReturn).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { suppliedFrom: { is: { attendeeId: 'att-1' } }, status: NominationStatus.Open },
            data: { status: NominationStatus.Paused, pausedFrom: NominationStatus.Open },
          }),
        );
        expect(db.eventGame.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['eg-1'] } } });
        expect(emitter.emit).toHaveBeenCalledWith(NominationPausedEvent.eventName, expect.any(NominationPausedEvent));
        expect(emitter.emit).toHaveBeenCalledWith(
          GameRemovedFromEventEvent.eventName,
          expect.any(GameRemovedFromEventEvent),
        );
      });
    });

    it('updateStatus → update', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
      } as EventAttendee);
      lockedStatus(EventParticipationStatus.Invited);
      db.eventAttendee.update.mockResolvedValue(attendeeRow({ status: EventParticipationStatus.Attending }));

      await service.updateStatus('event-1', 'att-1', { status: 'Attending' } as never);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventAttendee,
        Action.update,
      );
      expect(db.eventAttendee.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'att-1', removedAt: null, AND: [COND] } }),
      );
    });

    // Not attending takes the attendee out of the event: the nominations of
    // games from their list pause, whoever made them, and the scheduled
    // ones are deleted, in the transaction that writes the RSVP.
    it('updateStatus to NotAttending pauses the nominations supplied from their list and deletes their scheduled games', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
      } as EventAttendee);
      lockedStatus(EventParticipationStatus.Attending);
      db.eventAttendee.update.mockResolvedValue(attendeeRow({ status: EventParticipationStatus.NotAttending }));
      db.eventGameNomination.updateManyAndReturn.mockImplementation((async (args: {
        where: { status: NominationStatus };
      }) => (args.where.status === NominationStatus.AwaitingApproval ? [{ id: 'nom-2' }] : [])) as never);
      db.eventGame.findMany.mockResolvedValue([{ id: 'eg-1', eventId: 'event-1' } as EventGame]);

      await service.updateStatus('event-1', 'att-1', { status: EventParticipationStatus.NotAttending });

      for (const status of [NominationStatus.Open, NominationStatus.AwaitingApproval]) {
        expect(db.eventGameNomination.updateManyAndReturn).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { suppliedFrom: { is: { attendeeId: 'att-1' } }, status },
            data: { status: NominationStatus.Paused, pausedFrom: status },
          }),
        );
      }
      expect(db.eventGame.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { suppliedBy: { is: { attendeeId: 'att-1' } }, ...lineupStillAhead(expect.any(Date)) },
        }),
      );
      expect(db.eventGame.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['eg-1'] } } });

      const paused = emitter.emit.mock.calls.find(([name]) => name === NominationPausedEvent.eventName)?.[1];
      expect(paused).toBeInstanceOf(NominationPausedEvent);
      expect(paused.before).toEqual({ id: 'nom-2', eventId: 'event-1', status: NominationStatus.AwaitingApproval });
      expect(paused.after).toEqual({ id: 'nom-2', eventId: 'event-1', status: NominationStatus.Paused });

      const removedGame = emitter.emit.mock.calls.find(([name]) => name === GameRemovedFromEventEvent.eventName)?.[1];
      expect(removedGame).toBeInstanceOf(GameRemovedFromEventEvent);
      expect(removedGame.action).toBe('delete');
      expect(removedGame.subjectId).toBe('eg-1');
    });

    // A date write in flight finishes before the lineups are judged, and
    // the event's row is locked before any nomination: removing a date writes
    // to the nominations that name it while holding that row.
    it("updateStatus locks the event's dates after the RSVP write, before pausing a nomination", async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
      } as EventAttendee);
      lockedStatus(EventParticipationStatus.Attending);
      db.eventAttendee.update.mockResolvedValue(attendeeRow({ status: EventParticipationStatus.NotAttending }));

      await service.updateStatus('event-1', 'att-1', { status: EventParticipationStatus.NotAttending });

      // The first raw query is the attendee row's lock (#802).
      const [, [datesLock]] = db.$queryRaw.mock.calls;
      expect(rawQueryText(datesLock)).toMatch(/^SELECT id FROM events WHERE id = \? FOR SHARE$/);
      expect((datesLock as unknown as Prisma.Sql).values).toEqual(['event-1']);
      expect(db.$queryRaw.mock.invocationCallOrder[1]).toBeGreaterThan(
        db.eventAttendee.update.mock.invocationCallOrder[0],
      );
      expect(db.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        db.eventGameNomination.updateManyAndReturn.mock.invocationCallOrder[0],
      );
    });

    // Their paused nominations return to the status each paused from; the
    // deleted scheduled games are not restored.
    it('updateStatus back to Attending resumes the paused nominations and deletes nothing', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
      } as EventAttendee);
      lockedStatus(EventParticipationStatus.NotAttending);
      db.eventAttendee.update.mockResolvedValue(attendeeRow({ status: EventParticipationStatus.Attending }));
      db.eventGameNomination.updateManyAndReturn.mockImplementation((async (args: {
        where: { pausedFrom: NominationStatus };
      }) => (args.where.pausedFrom === NominationStatus.Open ? [{ id: 'nom-1' }] : [])) as never);

      await service.updateStatus('event-1', 'att-1', { status: EventParticipationStatus.Attending });

      for (const status of [NominationStatus.Open, NominationStatus.AwaitingApproval]) {
        expect(db.eventGameNomination.updateManyAndReturn).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              suppliedFrom: { is: { attendeeId: 'att-1' } },
              status: NominationStatus.Paused,
              pausedFrom: status,
            },
            data: { status, pausedFrom: null },
          }),
        );
      }
      expect(db.eventGame.findMany).not.toHaveBeenCalled();
      expect(db.eventGame.deleteMany).not.toHaveBeenCalled();

      const resumed = emitter.emit.mock.calls.find(([name]) => name === NominationResumedEvent.eventName)?.[1];
      expect(resumed).toBeInstanceOf(NominationResumedEvent);
      expect(resumed.before).toEqual({ id: 'nom-1', eventId: 'event-1', status: NominationStatus.Paused });
      expect(resumed.after).toEqual({ id: 'nom-1', eventId: 'event-1', status: NominationStatus.Open });
    });

    it('updateStatus emits an AttendeeStatusUpdatedEvent carrying the status transition', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
      } as EventAttendee);
      lockedStatus(EventParticipationStatus.Invited);
      db.eventAttendee.update.mockResolvedValue(attendeeRow({ status: EventParticipationStatus.Attending }));

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

    // Read before the lock, two RSVPs racing each other would both report the
    // status neither left, and the listener would take the second for an RSVP
    // sent again unchanged (#802).
    it("updateStatus reports the status it replaced as read under the attendee row's lock, before the write (#802)", async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      lockedStatus(EventParticipationStatus.NotAttending);
      db.eventAttendee.update.mockResolvedValue(attendeeRow({ status: EventParticipationStatus.Attending }));

      await service.updateStatus('event-1', 'att-1', { status: EventParticipationStatus.Attending });

      const [[attendeeLock]] = db.$queryRaw.mock.calls;
      expect(rawQueryText(attendeeLock)).toMatch(
        /^SELECT status, removed_at AS "removedAt" FROM event_attendees WHERE id = \? FOR NO KEY UPDATE$/,
      );
      expect((attendeeLock as unknown as Prisma.Sql).values).toEqual(['att-1']);
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        db.eventAttendee.update.mock.invocationCallOrder[0],
      );

      const [, emitted] = emitter.emit.mock.calls[0];
      expect(emitted.before.status).toBe(EventParticipationStatus.NotAttending);
    });

    // The attendee's removal committed between the first read and the lock:
    // they are gone, so the answer is 404, not the refusal (403) the update
    // matching nothing would read as.
    it('updateStatus answers 404 when the attendee is removed by the time the lock is held (#1064)', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      lockedStatus(EventParticipationStatus.Invited, new Date());
      db.eventAttendee.update.mockRejectedValue(recordNotFound());

      await expect(
        service.updateStatus('event-1', 'att-1', { status: EventParticipationStatus.Attending }),
      ).rejects.toThrow(NotFoundException);
      expect(db.eventAttendee.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('updateStatus still answers 403 when the update conditions refuse the write after the locked read (#1064)', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      lockedStatus(EventParticipationStatus.Invited);
      db.eventAttendee.update.mockRejectedValue(recordNotFound());

      await expect(
        service.updateStatus('event-1', 'att-1', { status: EventParticipationStatus.Attending }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('updateStatus carries who acted on the RSVP (#802)', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
      } as EventAttendee);
      lockedStatus(EventParticipationStatus.Invited);
      db.eventAttendee.update.mockResolvedValue(attendeeRow({ status: EventParticipationStatus.Attending }));

      await service.updateStatus('event-1', 'att-1', { status: EventParticipationStatus.Attending });

      const [, emitted] = emitter.emit.mock.calls[0];
      expect(emitted.actingUserId).toBe(MOCK_ACTING_USER_ID);
    });

    it('throws NotFound when removing a non-existent attendee', async () => {
      db.eventAttendee.findUnique.mockResolvedValue(null);
      await expect(service.removeAttendee('event-1', 'att-1')).rejects.toThrow(NotFoundException);
    });

    // The removed user's cached graph still carries the event role until it
    // is rebuilt, so without the eviction a removed co-host keeps co-hosting
    // for the cache's lifetime.
    it("removeAttendee evicts the removed user's cached permission graph", async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendee.update.mockResolvedValue({ id: 'att-1' } as EventAttendee);
      db.eventAttendee.findUniqueOrThrow.mockResolvedValue(attendeeRow({ removedAt: new Date() }));
      lockedAttendee({ removedAt: null });

      await service.removeAttendee('event-1', 'att-1');

      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('whom addAttendee may place on the event (#546)', () => {
    beforeEach(() => {
      abilityService.getActingUserId.mockReturnValue('user-actor');
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-actor' } as EventAttendee);
      db.eventAttendee.create.mockResolvedValue(
        makeEventAttendee({ id: 'att-new', eventId: 'event-1', userId: 'user-2' }),
      );
    });

    it('answers 404 for an id that names no person, and writes nothing', async () => {
      db.user.findUnique.mockResolvedValue(null);

      await expect(service.addAttendee('event-1', { userId: 'ghost' })).rejects.toThrow(NotFoundException);
      expect(db.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ghost', ...HUMAN_USER_WHERE } }),
      );
      expect(db.eventAttendee.create).not.toHaveBeenCalled();
    });

    it('answers 403 for a user who blocked the caller, or was blocked by them, and writes nothing', async () => {
      db.friendship.findFirst.mockResolvedValue({ status: FriendshipStatus.Blocked } as never);

      await expect(service.addAttendee('event-1', { userId: 'user-2' })).rejects.toThrow(ForbiddenException);
      expect(db.eventAttendee.create).not.toHaveBeenCalled();
    });

    it("reads the user's preference for events, not for households", async () => {
      db.userPreferences.findFirst.mockResolvedValue({
        allowHouseholdInvitesFrom: Reach.Private,
        allowEventInvitesFrom: Reach.Public,
      } as never);

      await service.addAttendee('event-1', { userId: 'user-2' });

      expect(db.eventAttendee.create).toHaveBeenCalled();

      db.userPreferences.findFirst.mockResolvedValue({
        allowHouseholdInvitesFrom: Reach.Public,
        allowEventInvitesFrom: Reach.Private,
      } as never);

      await expect(service.addAttendee('event-1', { userId: 'user-2' })).rejects.toThrow(ForbiddenException);
    });

    // Already on the event is the answer, whatever the checks would say now.
    it('answers 409 for a user already on the event, before asking whether they may be placed', async () => {
      db.eventAttendee.findFirst.mockResolvedValue({
        id: 'att-2',
        status: EventParticipationStatus.Attending,
        invitedById: null,
        removedAt: null,
      } as EventAttendee);

      await expect(service.addAttendee('event-1', { userId: 'user-2' })).rejects.toThrow(ConflictException);
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(db.eventAttendee.create).not.toHaveBeenCalled();
      expect(db.eventAttendee.update).not.toHaveBeenCalled();
    });

    it('asks nothing about the caller adding themselves', async () => {
      await service.addAttendee('event-1', { userId: 'user-actor' });

      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(db.eventAttendee.create).toHaveBeenCalled();
    });

    it('asks nothing about an attendee added by name, without an account', async () => {
      await service.addAttendee('event-1', { guestName: 'Pat' });

      expect(db.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('addAttendee authorization (#539)', () => {
    beforeEach(() => {
      abilityService.getActingUserId.mockReturnValue('user-actor');
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: 'hh-1' } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-actor' } as EventAttendee);
      db.eventAttendee.create.mockResolvedValue(
        makeEventAttendee({ id: 'att-new', eventId: 'event-1', userId: 'user-2' }),
      );
    });

    // The route's policy check judges a create on EventAttendee by type
    // alone, so a host of any event passes it for every event. The row about
    // to be written names its event, its household and its role, and those
    // are what the grants bind to. Which roles each grant gives out is the
    // catalog's, and the ability factory's spec holds it to that.
    it('checks the create against the event it adds to and the role it writes', async () => {
      await service.addAttendee('event-1', { userId: 'user-2', role: SystemRole.EventCoHost });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.EventAttendee, {
        eventId: 'event-1',
        event: { householdId: 'hh-1' },
        role: { role: { name: SystemRole.EventCoHost } },
      });
    });

    it('checks, and writes, the participant role when the request names none', async () => {
      await service.addAttendee('event-1', { userId: 'user-2' });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.create,
        ResourceType.EventAttendee,
        expect.objectContaining({ role: { role: { name: SystemRole.EventParticipant } } }),
      );
      expect(db.eventAttendee.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: { create: { role: { connect: { name: SystemRole.EventParticipant } } } },
          }),
        }),
      );
    });

    it('refuses before writing when the instance check denies', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(
        service.addAttendee('event-1', { userId: 'user-actor', role: SystemRole.EventCoHost }),
      ).rejects.toThrow(ForbiddenException);
      expect(db.eventAttendee.create).not.toHaveBeenCalled();
    });

    // The added user's graph was cached without this event: their role here
    // would otherwise reach them only when the cache expires.
    it("evicts the added user's cached permission graph", async () => {
      await service.addAttendee('event-1', { userId: 'user-2' });

      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-2');
    });
  });

  // A removed user keeps their row, and the (event, user) key with it, so
  // adding them again revives the row rather than answering 409.
  describe('addAttendee for a user a host removed', () => {
    const removedAt = new Date('2026-10-15T12:00:00Z');

    beforeEach(() => {
      abilityService.getActingUserId.mockReturnValue('user-actor');
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-actor' } as EventAttendee);
      db.eventAttendee.findFirst.mockResolvedValue({
        id: 'att-2',
        status: EventParticipationStatus.Attending,
        invitedById: null,
        removedAt,
      } as EventAttendee);
      db.eventAttendee.update.mockResolvedValue(
        makeEventAttendee({ id: 'att-2', eventId: 'event-1', userId: 'user-2', invitedById: 'att-actor' }),
      );
    });

    it('revives the removed row with a fresh role, and creates none', async () => {
      await service.addAttendee('event-1', { userId: 'user-2', role: SystemRole.EventSpectator });

      expect(db.eventAttendee.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1', userId: 'user-2' } }),
      );
      expect(db.eventAttendee.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-2', removedAt: { not: null } },
          data: expect.objectContaining({
            removedAt: null,
            rsvpDate: null,
            status: EventParticipationStatus.Invited,
            invitedBy: { connect: { id: 'att-actor' } },
            role: { create: { role: { connect: { name: SystemRole.EventSpectator } } } },
          }),
        }),
      );
      expect(db.eventAttendee.create).not.toHaveBeenCalled();
    });

    it('emits an AttendeeAddedEvent as an update of the removed row', async () => {
      await service.addAttendee('event-1', { userId: 'user-2' });

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(AttendeeAddedEvent.eventName);
      expect(emitted.action).toBe('update');
      expect(emitted.subjectId).toBe('att-2');
      expect(emitted.before).toEqual(expect.objectContaining({ id: 'att-2', removedAt }));
      expect(emitted.after).toEqual(expect.objectContaining({ id: 'att-2', removedAt: null }));
    });

    // Back in the event, their paused nominations resume.
    it('resumes the nominations supplied from their list', async () => {
      await service.addAttendee('event-1', { userId: 'user-2' });

      expect(db.eventGameNomination.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            suppliedFrom: { is: { attendeeId: 'att-2' } },
            status: NominationStatus.Paused,
          }),
        }),
      );
    });

    it("evicts the revived user's cached permission graph", async () => {
      await service.addAttendee('event-1', { userId: 'user-2' });

      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-2');
    });
  });

  describe('EventAttendeeGameList resource', () => {
    // #512 composed it; #1001 pages it, through the same read as the
    // offered-games route, with the attendee fixed. The attendee's own clause
    // drops their entries the moment they're removed, as the event-wide read
    // does (#1187).
    it("pages one attendee's offered games in title order, removed entries left out (#1001)", async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendeeGameList.findMany.mockResolvedValue([makeOfferedGameEntry('gl-2')] as never);
      db.eventAttendeeGameList.count.mockResolvedValue(3);

      const page = await service.getGameList('event-1', 'att-1', paginationQuery({ page: 2, limit: 1 }));

      const scope = {
        attendeeId: 'att-1',
        removedAt: null,
        attendee: { is: { eventId: 'event-1', removedAt: null } },
      };
      const where = { ...scope, AND: [COND] };
      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendeeGameList, Action.read, scope);
      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith({
        where,
        select: OFFERED_GAME_SELECT,
        orderBy: OFFERED_GAME_ORDER,
        skip: 1,
        take: 1,
      });
      expect(db.eventAttendeeGameList.count).toHaveBeenCalledWith({ where });
      expect(batchTransactionCall(db).options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      expect(page.total).toBe(3);
      expect(page.rows.map((row) => row.id)).toEqual(['gl-2']);
      expect(page.rows[0].supplies).toEqual({ nominations: 0, lineup: 0 });
    });

    it('answers 404 for an attendee not on the event, before reading their games', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue(null);

      await expect(service.getGameList('event-1', 'att-x', paginationQuery())).rejects.toThrow(NotFoundException);
      expect(db.eventAttendeeGameList.findMany).not.toHaveBeenCalled();
    });

    // The owner's rating, comment, play count and quantity are theirs, not
    // the event's. One select serves every site, and naming its collection
    // keys pins them, so a column added to GameCollection reaches none.
    it('serves no collection column beyond id and medium at any offered-game site (#1185)', async () => {
      expect(Object.keys(OFFERED_GAME_SELECT.collection.select)).toEqual(['id', 'medium', 'platformGame']);

      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.create.mockResolvedValue(makeOfferedGameEntry('gl-1') as never);
      db.eventAttendeeGameList.update.mockResolvedValue(makeOfferedGameEntry('gl-2') as never);

      await service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' });
      db.eventAttendeeGameList.findFirst.mockResolvedValue(
        makeEventAttendeeGameList('att-1', 'col-2', { id: 'gl-2', removedAt: new Date('2026-10-15T12:00:00Z') }),
      );
      await service.addGameToList('event-1', 'att-1', { collectionId: 'col-2' });

      const [created] = db.eventAttendeeGameList.create.mock.calls[0];
      const [revived] = db.eventAttendeeGameList.update.mock.calls[0];
      expect(created).toEqual(expect.objectContaining({ select: OFFERED_GAME_SELECT }));
      expect(created).not.toHaveProperty('include');
      expect(revived).toEqual(expect.objectContaining({ select: OFFERED_GAME_SELECT }));
      expect(revived).not.toHaveProperty('include');
    });

    it('answers the add with the offered game, its base games and supplies read (#1187)', async () => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.create.mockResolvedValue(makeOfferedGameEntry('gl-1', 'game-exp') as never);
      db.gameExpansion.findMany.mockResolvedValue([
        { expansionGameId: 'game-exp', baseGameId: 'game-base', isStandalone: false },
      ] as never);

      const entry = await service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' });

      expect(entry.id).toBe('gl-1');
      expect(entry.collection.platformGame.game.baseGames).toEqual([{ gameId: 'game-base', isStandalone: false }]);
      expect(entry.supplies).toEqual({ nominations: 0, lineup: 0 });
    });

    it('addGameToList emits a GameAddedToListEvent (create) for the new row', async () => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.create.mockResolvedValue(makeOfferedGameEntry('gl-1') as never);

      await service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' });

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(GameAddedToListEvent.eventName);
      expect(emitted).toBeInstanceOf(GameAddedToListEvent);
      expect(emitted.action).toBe('create');
      expect(emitted.subjectId).toBe('gl-1');
      expect(emitted.eventId).toBe('event-1');
      expect(emitted.before).toBeNull();
      expect(emitted.after).toEqual({ id: 'gl-1', attendeeId: 'att-1', collectionId: 'col-1', removedAt: null });
    });

    // The row of a game taken off the list stays, and so does its
    // (attendee, game) key: putting the game back revives it.
    it('addGameToList revives an entry taken off the list, as an update', async () => {
      const removedAt = new Date('2026-10-15T12:00:00Z');
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.findFirst.mockResolvedValue(
        makeEventAttendeeGameList('att-1', 'col-1', { id: 'gl-1', removedAt }),
      );
      db.eventAttendeeGameList.update.mockResolvedValue(makeOfferedGameEntry('gl-1') as never);

      await service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' });

      expect(db.eventAttendeeGameList.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'gl-1', removedAt: { not: null } }, data: { removedAt: null } }),
      );
      expect(db.eventAttendeeGameList.create).not.toHaveBeenCalled();

      const [, emitted] = emitter.emit.mock.calls[0];
      expect(emitted.action).toBe('update');
      expect(emitted.before).toEqual(expect.objectContaining({ id: 'gl-1', removedAt }));
      expect(emitted.after).toEqual(expect.objectContaining({ id: 'gl-1', removedAt: null }));
    });

    // The route's policy check judges a create by type alone — and `manage`
    // implies `create`, so a manager passes it for any attendee's list while a
    // participant passes it for their own. The service checks the entry it is
    // about to write, carrying the attendee's user and event so both grants
    // can bind.
    it('addGameToList checks the create against the entry it is about to write', async () => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: 'hh-1' } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.create.mockResolvedValue(makeOfferedGameEntry('gl-1') as never);

      await service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.create,
        ResourceType.EventAttendeeGameList,
        {
          attendeeId: 'att-1',
          attendee: { id: 'att-1', userId: 'user-1', eventId: 'event-1', event: { householdId: 'hh-1' } },
        },
      );
    });

    it('addGameToList refuses before writing when the instance check denies', async () => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' })).rejects.toThrow(
        ForbiddenException,
      );
      expect(db.eventAttendeeGameList.create).not.toHaveBeenCalled();
    });

    describe('removeGameFromList', () => {
      const removedAt = new Date('2026-10-15T12:00:00Z');

      beforeEach(() => {
        db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
        db.eventAttendeeGameList.findUnique.mockResolvedValue(
          makeEventAttendeeGameList('att-1', 'col-1', { id: 'gl-1' }),
        );
        db.$queryRaw.mockResolvedValue([{ removedAt: null }] as never);
        db.eventAttendeeGameList.count.mockResolvedValue(1);
        db.eventGameNomination.count.mockResolvedValue(0);
        db.eventGame.count.mockResolvedValue(0);
        db.eventAttendeeGameList.update.mockResolvedValue(
          makeEventAttendeeGameList('att-1', 'col-1', { id: 'gl-1', removedAt }),
        );
      });

      // Closed nominations still name the entry as their supplier, so it is
      // marked removed rather than deleted.
      it('marks the entry removed, under the delete conditions, instead of deleting it', async () => {
        await service.removeGameFromList('event-1', 'att-1', 'gl-1');

        expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
          ResourceType.EventAttendeeGameList,
          Action.delete,
        );
        expect(db.eventAttendeeGameList.update).toHaveBeenCalledWith({
          where: { id: 'gl-1', removedAt: null, AND: [COND] },
          data: { removedAt: expect.any(Date) },
        });
        expect(db.eventAttendeeGameList.delete).not.toHaveBeenCalled();
      });

      it("counts what the entry supplies after locking it, and the event's dates", async () => {
        await service.removeGameFromList('event-1', 'att-1', 'gl-1');

        expect(db.$queryRaw).toHaveBeenCalledTimes(2);
        const [, [datesLock]] = db.$queryRaw.mock.calls;
        expect(rawQueryText(datesLock)).toMatch(/^SELECT id FROM events WHERE id = \? FOR SHARE$/);
        expect((datesLock as unknown as Prisma.Sql).values).toEqual(['event-1']);
        expect(db.eventGameNomination.count).toHaveBeenCalledWith({
          where: {
            suppliedFromId: 'gl-1',
            status: { in: [NominationStatus.Open, NominationStatus.AwaitingApproval, NominationStatus.Paused] },
          },
        });
        expect(db.eventGame.count).toHaveBeenCalledWith({
          where: { suppliedById: 'gl-1', ...lineupStillAhead(expect.any(Date)) },
        });
        expect(db.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
          db.eventGameNomination.count.mock.invocationCallOrder[0],
        );
        expect(db.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(db.eventGame.count.mock.invocationCallOrder[0]);
      });

      // An attendee acting alone does not pull a game from the lineup the
      // host built, or from a nomination still awaiting an outcome.
      it.each([
        ['a nomination awaiting an outcome', 1, 0],
        ['a game in the lineup', 0, 1],
      ])('answers 409 while the entry supplies %s, and writes nothing', async (_what, nominations, scheduled) => {
        db.eventGameNomination.count.mockResolvedValue(nominations);
        db.eventGame.count.mockResolvedValue(scheduled);

        await expect(service.removeGameFromList('event-1', 'att-1', 'gl-1')).rejects.toThrow(ConflictException);
        expect(db.eventAttendeeGameList.update).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      // The 409 names what the entry supplies, so it goes only to a caller who
      // could have taken the game off.
      it('answers 403 to a caller who may not take it off, before saying what it supplies', async () => {
        db.eventAttendeeGameList.count.mockResolvedValue(0);
        db.eventGameNomination.count.mockResolvedValue(1);

        await expect(service.removeGameFromList('event-1', 'att-1', 'gl-1')).rejects.toThrow(ForbiddenException);
        expect(db.eventAttendeeGameList.count).toHaveBeenCalledWith({ where: { id: 'gl-1', AND: [COND] } });
        expect(db.eventGameNomination.count).not.toHaveBeenCalled();
        expect(db.eventAttendeeGameList.update).not.toHaveBeenCalled();
      });

      it('answers 404 for an entry already taken off the list', async () => {
        db.eventAttendeeGameList.findUnique.mockResolvedValue(null);

        await expect(service.removeGameFromList('event-1', 'att-1', 'gl-1')).rejects.toThrow(NotFoundException);
        expect(db.eventAttendeeGameList.findUnique).toHaveBeenCalledWith({
          where: { id: 'gl-1', attendeeId: 'att-1', removedAt: null },
        });
      });

      // Another request took it off between the read and the lock.
      it('answers 404 when a concurrent request took the entry off first, and writes nothing', async () => {
        db.$queryRaw.mockResolvedValue([{ removedAt }] as never);

        await expect(service.removeGameFromList('event-1', 'att-1', 'gl-1')).rejects.toThrow(NotFoundException);
        expect(db.eventAttendeeGameList.update).not.toHaveBeenCalled();
      });

      it('emits a GameRemovedFromListEvent as an update of removedAt', async () => {
        await service.removeGameFromList('event-1', 'att-1', 'gl-1');

        const [name, emitted] = emitter.emit.mock.calls[0];
        expect(name).toBe(GameRemovedFromListEvent.eventName);
        expect(emitted).toBeInstanceOf(GameRemovedFromListEvent);
        expect(emitted.action).toBe('update');
        expect(emitted.subjectId).toBe('gl-1');
        expect(emitted.eventId).toBe('event-1');
        expect(emitted.before).toEqual({ id: 'gl-1', attendeeId: 'att-1', collectionId: 'col-1', removedAt: null });
        expect(emitted.after).toEqual({ id: 'gl-1', attendeeId: 'att-1', collectionId: 'col-1', removedAt });
      });
    });
  });
  // #404's sixth site: the attendee routes' embed was an include, so it reached
  // anyone who could read attendees, whatever their read on offered games.
  // It's now a read of its own under the offered-games read ceiling, in the
  // offered-game shape.
  describe("the attendee routes' offered games (#404, #1187)", () => {
    const withGames = (id: string, gameListIds: string[]) =>
      db.eventAttendeeGameList.findMany.mockResolvedValue(
        gameListIds.map((gameListId) => makeOfferedGameEntry(gameListId, 'game-1', id)) as never,
      );

    it("attaches the attendee list's games from their own read under the offered-games read ceiling (#404)", async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([
        attendeeRow({ id: 'att-1' }),
        attendeeRow({ id: 'att-2', userId: 'user-2' }),
      ]);
      withGames('att-1', ['gl-1']);

      const page = await service.getAttendees('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: ATTENDEE_USER_AND_ROLE_INCLUDE }),
      );
      expect(forAttendees).toHaveBeenCalledWith(['att-1', 'att-2'], expect.any(Date));
      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendeeGameList, Action.read, {
        attendeeId: { in: ['att-1', 'att-2'] },
        removedAt: null,
      });
      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith({
        where: { attendeeId: { in: ['att-1', 'att-2'] }, removedAt: null, AND: [COND] },
        select: OFFERED_GAME_SELECT,
        orderBy: OFFERED_GAME_ORDER,
      });
      expect(page.rows.map((row) => row.availableGames.map((game) => game.id))).toEqual([['gl-1'], []]);
    });

    it("attaches one attendee's games to getAttendee", async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue(attendeeRow());
      withGames('att-1', ['gl-1', 'gl-2']);

      const attendee = await service.getAttendee('event-1', 'att-1');

      expect(db.eventAttendee.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ include: ATTENDEE_USER_AND_ROLE_INCLUDE }),
      );
      expect(forAttendees).toHaveBeenCalledWith(['att-1'], expect.any(Date));
      expect(attendee.availableGames.map((game) => game.id)).toEqual(['gl-1', 'gl-2']);
    });

    it("attaches the answered attendee's games to updateStatus, after the write commits", async () => {
      const order: string[] = [];
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      lockedStatus(EventParticipationStatus.Invited);
      db.eventAttendee.update.mockResolvedValue(attendeeRow({ status: EventParticipationStatus.Attending }));
      db.$transaction.mockImplementation((async (callback: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await callback(db);
        order.push('commit');
        return result;
      }) as never);
      forAttendees.mockImplementation(async () => {
        order.push('attach');
        return new Map([['att-1', []]]);
      });

      const updated = await service.updateStatus('event-1', 'att-1', { status: 'Attending' } as never);

      expect(db.eventAttendee.update).toHaveBeenCalledWith(
        expect.objectContaining({ include: ATTENDEE_USER_AND_ROLE_INCLUDE }),
      );
      expect(order).toEqual(['commit', 'attach']);
      expect(updated.availableGames).toEqual([]);
    });

    it("attaches the added attendee's games to addAttendee", async () => {
      abilityService.getActingUserId.mockReturnValue('user-actor');
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-actor' } as EventAttendee);
      db.eventAttendee.create.mockResolvedValue(
        makeEventAttendee({ id: 'att-new', eventId: 'event-1', userId: 'user-2' }),
      );

      const added = await service.addAttendee('event-1', { userId: 'user-2' });

      expect(db.eventAttendee.create).toHaveBeenCalledWith(
        expect.objectContaining({ include: ATTENDEE_USER_AND_ROLE_INCLUDE }),
      );
      expect(forAttendees).toHaveBeenCalledWith(['att-new'], expect.any(Date));
      expect(added.availableGames).toEqual([]);
    });

    it("attaches the removed attendee's games to removeAttendee's answer", async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendee.update.mockResolvedValue({ id: 'att-1' } as EventAttendee);
      db.eventAttendee.findUniqueOrThrow.mockResolvedValue(attendeeRow({ removedAt: new Date() }));
      lockedAttendee({ removedAt: null });
      withGames('att-1', ['gl-1']);

      const removed = await service.removeAttendee('event-1', 'att-1');

      expect(db.eventAttendee.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({ include: ATTENDEE_USER_AND_ROLE_INCLUDE }),
      );
      expect(removed.availableGames.map((game) => game.id)).toEqual(['gl-1']);
    });

    // The games are read after the write commits. A failure there is the
    // read's: mapped as the write's, a unique-key or no-row error would
    // answer 409 or 403 for a write that went through.
    it('answers a failure of the games read after a committed write as itself, not as a refused write (#1187)', async () => {
      const unique = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
      const noRow = new Prisma.PrismaClientKnownRequestError('No record was found', {
        code: 'P2025',
        clientVersion: 'test',
      });

      abilityService.getActingUserId.mockReturnValue('user-actor');
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-actor' } as EventAttendee);
      db.eventAttendee.create.mockResolvedValue(makeEventAttendee({ id: 'att-new', eventId: 'event-1' }));
      forAttendees.mockRejectedValueOnce(unique);
      await expect(service.addAttendee('event-1', { userId: 'user-2' })).rejects.toBe(unique);
      expect(db.eventAttendee.create).toHaveBeenCalledTimes(1);

      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendee.update.mockResolvedValue(attendeeRow());
      db.eventAttendee.findUniqueOrThrow.mockResolvedValue(attendeeRow({ removedAt: new Date() }));
      lockedAttendee({ removedAt: null });
      forAttendees.mockRejectedValueOnce(noRow);
      await expect(service.removeAttendee('event-1', 'att-1')).rejects.toBe(noRow);

      lockedStatus(EventParticipationStatus.Invited);
      forAttendees.mockRejectedValueOnce(noRow);
      await expect(service.updateStatus('event-1', 'att-1', { status: 'Attending' } as never)).rejects.toBe(noRow);

      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.create.mockResolvedValue(makeOfferedGameEntry('gl-1') as never);
      db.gameExpansion.findMany.mockRejectedValueOnce(unique);
      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' })).rejects.toBe(unique);
      expect(emitter.emit).toHaveBeenCalledWith(GameAddedToListEvent.eventName, expect.anything());
    });
  });
  // #1188: each id is judged as the single add judges one, a bad id loses
  // nothing else, and the answer says what happened to each.
  describe('offerGames (#1188)', () => {
    const removedAt = new Date('2026-10-15T12:00:00Z');

    /** A collection entry as the batch reads it: its owner, tombstone and game. */
    const owned = (id: string, gameId: string, overrides: { userId?: string; deletedAt?: Date | null } = {}) => ({
      id,
      userId: 'user-1',
      deletedAt: null,
      platformGame: { gameId },
      ...overrides,
    });

    /** An entry the attendee already offers, as the batch reads it: in the offered shape, with its key and tombstone. */
    const listed = (collectionId: string, gameListId: string, entryRemovedAt: Date | null = null) => ({
      ...makeOfferedGameEntry(gameListId),
      collectionId,
      removedAt: entryRemovedAt,
    });

    /**
     * The database the batch reads: `collections` by id, the attendee's
     * `entries` by collection id, and the expansion `links`, each read
     * filtered by its where as Postgres would. Creates and revives answer
     * an offered entry named after the collection entry.
     */
    const arrange = ({
      collections = [],
      entries = [],
      links = [],
    }: {
      collections?: ReturnType<typeof owned>[];
      entries?: ReturnType<typeof listed>[];
      links?: { baseGameId: string; expansionGameId: string }[];
    }) => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: 'hh-1' } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findMany.mockImplementation((async (args: { where: { id: { in: string[] } } }) =>
        collections.filter(({ id }) => args.where.id.in.includes(id))) as never);
      db.eventAttendeeGameList.findMany.mockImplementation((async (args: {
        where: { collectionId: { in: string[] } };
      }) => entries.filter(({ collectionId }) => args.where.collectionId.in.includes(collectionId))) as never);
      db.gameExpansion.findMany.mockImplementation((async (args: {
        where: { baseGameId?: { in: string[] }; expansionGameId: { in: string[] } };
      }) =>
        args.where.baseGameId
          ? links.filter(
              ({ baseGameId, expansionGameId }) =>
                args.where.baseGameId?.in.includes(baseGameId) &&
                args.where.expansionGameId.in.includes(expansionGameId),
            )
          : []) as never);
      db.eventAttendeeGameList.create.mockImplementation((async (args: {
        data: { collection: { connect: { id: string } } };
      }) => makeOfferedGameEntry(`gl-${args.data.collection.connect.id}`)) as never);
      db.eventAttendeeGameList.update.mockImplementation((async (args: { where: { id: string } }) =>
        makeOfferedGameEntry(args.where.id)) as never);
    };

    const outcomes = (results: { collectionId: string; outcome: string; reason?: string }[]) =>
      results.map(({ collectionId, outcome, reason }) => [collectionId, reason ?? outcome]);

    it('judges every id with two reads, not one per id', async () => {
      arrange({
        collections: [owned('col-base', 'game-base'), owned('col-exp', 'game-exp'), owned('col-other', 'game-other')],
        links: [{ baseGameId: 'game-base', expansionGameId: 'game-exp' }],
      });

      await service.offerGames('event-1', 'att-1', {
        items: [{ collectionId: 'col-base', expansionCollectionIds: ['col-exp'] }, { collectionId: 'col-other' }],
      });

      expect(db.gameCollection.findMany).toHaveBeenCalledTimes(1);
      expect(db.gameCollection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['col-base', 'col-exp', 'col-other'] } } }),
      );
      expect(db.gameCollection.findUnique).not.toHaveBeenCalled();
      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { attendeeId: 'att-1', collectionId: { in: ['col-base', 'col-exp', 'col-other'] } },
        }),
      );
      const linkReads = db.gameExpansion.findMany.mock.calls.filter(([args]) => 'baseGameId' in (args?.where ?? {}));
      expect(linkReads).toEqual([
        [
          {
            where: { baseGameId: { in: ['game-base'] }, expansionGameId: { in: ['game-exp'] } },
            select: { baseGameId: true, expansionGameId: true },
          },
        ],
      ]);
    });

    it('adds new entries and revives taken-back ones, one GameAddedToListEvent each', async () => {
      arrange({
        collections: [owned('col-new', 'game-1'), owned('col-old', 'game-2')],
        entries: [listed('col-old', 'gl-old', removedAt)],
      });

      const results = await service.offerGames('event-1', 'att-1', {
        items: [{ collectionId: 'col-new' }, { collectionId: 'col-old' }],
      });

      expect(outcomes(results)).toEqual([
        ['col-new', 'added'],
        ['col-old', 'added'],
      ]);
      expect(db.eventAttendeeGameList.create).toHaveBeenCalledWith({
        data: { attendee: { connect: { id: 'att-1' } }, collection: { connect: { id: 'col-new' } } },
        select: OFFERED_GAME_SELECT,
      });
      expect(db.eventAttendeeGameList.update).toHaveBeenCalledWith({
        where: { id: 'gl-old', removedAt: { not: null } },
        data: { removedAt: null },
        select: OFFERED_GAME_SELECT,
      });

      const emitted = emitter.emit.mock.calls.filter(([name]) => name === GameAddedToListEvent.eventName);
      expect(emitted.map(([, event]) => [event.action, event.before, event.after])).toEqual([
        ['create', null, { id: 'gl-col-new', attendeeId: 'att-1', collectionId: 'col-new', removedAt: null }],
        [
          'update',
          { id: 'gl-old', attendeeId: 'att-1', collectionId: 'col-old', removedAt },
          { id: 'gl-old', attendeeId: 'att-1', collectionId: 'col-old', removedAt: null },
        ],
      ]);
      expect(results.map((result) => (result.outcome === 'refused' ? null : result.entry.id))).toEqual([
        'gl-col-new',
        'gl-old',
      ]);
      expect(results[0]).toEqual(
        expect.objectContaining({ entry: expect.objectContaining({ supplies: { nominations: 0, lineup: 0 } }) }),
      );
    });

    // An entry already offered isn't a failure, and was added by
    // someone before: nothing is written and nothing is emitted.
    it('answers an entry already offered as alreadyOffered, with its entry, and emits nothing (#1188)', async () => {
      arrange({
        collections: [owned('col-on', 'game-1'), owned('col-raced', 'game-2')],
        entries: [listed('col-on', 'gl-on')],
      });
      // A concurrent add wins the (attendee, collection) key between the read
      // and the write.
      db.eventAttendeeGameList.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
      );
      db.eventAttendeeGameList.findFirst.mockResolvedValue(makeOfferedGameEntry('gl-raced') as never);

      const results = await service.offerGames('event-1', 'att-1', {
        items: [{ collectionId: 'col-on' }, { collectionId: 'col-raced' }],
      });

      expect(outcomes(results)).toEqual([
        ['col-on', 'alreadyOffered'],
        ['col-raced', 'alreadyOffered'],
      ]);
      expect(results.map((result) => (result.outcome === 'refused' ? null : result.entry.id))).toEqual([
        'gl-on',
        'gl-raced',
      ]);
      expect(results[0]).not.toHaveProperty('entry.removedAt');
      expect(results[0]).not.toHaveProperty('entry.collectionId');
      expect(db.eventAttendeeGameList.findFirst).toHaveBeenCalledWith({
        where: { attendeeId: 'att-1', collectionId: 'col-raced', removedAt: null },
        select: OFFERED_GAME_SELECT,
      });
      expect(emitter.emit).not.toHaveBeenCalledWith(GameAddedToListEvent.eventName, expect.anything());
    });

    // A bad id loses nothing else: an entry deleted between the check and
    // its write fails the write's connect, and is refused as missing rather
    // than failing the request after the others were written.
    it('refuses an entry that vanishes before its write as notFound, and still adds the rest (#1188)', async () => {
      arrange({ collections: [owned('col-gone', 'game-1'), owned('col-ok', 'game-2')] });
      db.eventAttendeeGameList.create.mockImplementation((async (args: {
        data: { collection: { connect: { id: string } } };
      }) => {
        if (args.data.collection.connect.id === 'col-gone') {
          throw new Prisma.PrismaClientKnownRequestError('No record was found for a connect.', {
            code: 'P2025',
            clientVersion: 'test',
          });
        }

        return makeOfferedGameEntry(`gl-${args.data.collection.connect.id}`);
      }) as never);

      const results = await service.offerGames('event-1', 'att-1', {
        items: [{ collectionId: 'col-gone' }, { collectionId: 'col-ok' }],
      });

      expect(outcomes(results)).toEqual([
        ['col-gone', OfferRefusal.NotFound],
        ['col-ok', 'added'],
      ]);
      expect(results[0]).toEqual(
        expect.objectContaining({
          message: t('errors.attendee.game_collection_entry_not_found', { collectionId: 'col-gone' }),
        }),
      );
      expect(emitter.emit.mock.calls.filter(([name]) => name === GameAddedToListEvent.eventName)).toHaveLength(1);
    });

    // A game's entry can vanish between the judgement and its write: deleting
    // the game cascades to its collection entries, and an expansion's entry,
    // another game's, survives. The game is then refused, so the expansions
    // asked for with it are too, as at judging; one already offered stays so.
    it('refuses the expansions of a game whose entry vanishes before its write as baseRefused (#1188)', async () => {
      arrange({
        collections: [
          owned('col-base', 'game-base'),
          owned('col-exp', 'game-exp'),
          owned('col-on', 'game-on'),
          owned('col-other', 'game-other'),
        ],
        entries: [listed('col-on', 'gl-on')],
        links: [
          { baseGameId: 'game-base', expansionGameId: 'game-exp' },
          { baseGameId: 'game-base', expansionGameId: 'game-on' },
        ],
      });
      db.eventAttendeeGameList.create.mockImplementation((async (args: {
        data: { collection: { connect: { id: string } } };
      }) => {
        if (args.data.collection.connect.id === 'col-base') {
          throw new Prisma.PrismaClientKnownRequestError('No record was found for a connect.', {
            code: 'P2025',
            clientVersion: 'test',
          });
        }

        return makeOfferedGameEntry(`gl-${args.data.collection.connect.id}`);
      }) as never);

      const results = await service.offerGames('event-1', 'att-1', {
        items: [
          { collectionId: 'col-base', expansionCollectionIds: ['col-exp', 'col-on'] },
          { collectionId: 'col-other' },
        ],
      });

      expect(outcomes(results)).toEqual([
        ['col-base', OfferRefusal.NotFound],
        ['col-exp', OfferRefusal.BaseRefused],
        ['col-on', 'alreadyOffered'],
        ['col-other', 'added'],
      ]);
      expect(results[1]).toEqual(expect.objectContaining({ message: t('errors.attendee.base_refused') }));
      expect(db.eventAttendeeGameList.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ collection: { connect: { id: 'col-exp' } } }) }),
      );
    });

    // A refused game's expansions answer baseRefused whenever the game is
    // refused, so an expansion with a reason of its own answers the same
    // whether its game failed at judging or at its write.
    it('refuses as baseRefused an expansion with a reason of its own when its game is refused at its write (#1188)', async () => {
      arrange({
        collections: [owned('col-base', 'game-base'), owned('col-loose', 'game-loose')],
        links: [],
      });
      db.eventAttendeeGameList.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('No record was found for a connect.', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      const results = await service.offerGames('event-1', 'att-1', {
        items: [{ collectionId: 'col-base', expansionCollectionIds: ['col-loose'] }],
      });

      expect(outcomes(results)).toEqual([
        ['col-base', OfferRefusal.NotFound],
        ['col-loose', OfferRefusal.BaseRefused],
      ]);
    });

    it('refuses each bad id with its reason and a translated message, and still adds the rest', async () => {
      arrange({
        collections: [
          owned('col-stranger', 'game-1', { userId: 'user-9' }),
          owned('col-gone', 'game-2', { deletedAt: removedAt }),
          owned('col-ok', 'game-3'),
        ],
      });

      const results = await service.offerGames('event-1', 'att-1', {
        items: [
          { collectionId: 'col-missing' },
          { collectionId: 'col-stranger' },
          { collectionId: 'col-gone' },
          { collectionId: 'col-ok' },
        ],
      });

      expect(results.slice(0, 3)).toEqual([
        {
          collectionId: 'col-missing',
          outcome: 'refused',
          reason: OfferRefusal.NotFound,
          message: t('errors.attendee.game_collection_entry_not_found', { collectionId: 'col-missing' }),
        },
        {
          collectionId: 'col-stranger',
          outcome: 'refused',
          reason: OfferRefusal.NotInAttendeesCollection,
          message: t('errors.attendee.game_from_other_collection'),
        },
        {
          collectionId: 'col-gone',
          outcome: 'refused',
          reason: OfferRefusal.RemovedFromCollection,
          message: t('errors.attendee.game_removed_from_collection'),
        },
      ]);
      expect(outcomes(results)[3]).toEqual(['col-ok', 'added']);
      expect(db.eventAttendeeGameList.create).toHaveBeenCalledTimes(1);
    });

    // The link's direction says which game is the base, as base games are
    // read on a row (#1069).
    it("refuses an expansion not linked to its item's game, or linked the other way round", async () => {
      arrange({
        collections: [
          owned('col-base', 'game-base'),
          owned('col-exp', 'game-exp'),
          owned('col-unlinked', 'game-x'),
          owned('col-reverse', 'game-rev'),
        ],
        links: [
          { baseGameId: 'game-base', expansionGameId: 'game-exp' },
          { baseGameId: 'game-rev', expansionGameId: 'game-base' },
        ],
      });

      const results = await service.offerGames('event-1', 'att-1', {
        items: [{ collectionId: 'col-base', expansionCollectionIds: ['col-unlinked', 'col-exp', 'col-reverse'] }],
      });

      expect(outcomes(results)).toEqual([
        ['col-base', 'added'],
        ['col-unlinked', OfferRefusal.NotAnExpansionOfBase],
        ['col-exp', 'added'],
        ['col-reverse', OfferRefusal.NotAnExpansionOfBase],
      ]);
      expect(results[1]).toEqual(expect.objectContaining({ message: t('errors.attendee.not_an_expansion_of_base') }));
    });

    it('refuses the expansions of a refused game as baseRefused, and lets those of an already-offered game through', async () => {
      arrange({
        collections: [
          owned('col-stranger', 'game-1', { userId: 'user-9' }),
          owned('col-e1', 'game-e1'),
          owned('col-on', 'game-2'),
          owned('col-e2', 'game-e2'),
        ],
        entries: [listed('col-on', 'gl-on')],
        links: [
          { baseGameId: 'game-1', expansionGameId: 'game-e1' },
          { baseGameId: 'game-2', expansionGameId: 'game-e2' },
        ],
      });

      const results = await service.offerGames('event-1', 'att-1', {
        items: [
          { collectionId: 'col-stranger', expansionCollectionIds: ['col-e1'] },
          { collectionId: 'col-on', expansionCollectionIds: ['col-e2'] },
        ],
      });

      expect(outcomes(results)).toEqual([
        ['col-stranger', OfferRefusal.NotInAttendeesCollection],
        ['col-e1', OfferRefusal.BaseRefused],
        ['col-on', 'alreadyOffered'],
        ['col-e2', 'added'],
      ]);
      expect(results[1]).toEqual(expect.objectContaining({ message: t('errors.attendee.base_refused') }));
    });

    // Nothing is written for an entry already offered, so nothing about it is
    // judged: one removed from its collection since stays offered until it's
    // taken back, and answering it refused would say it isn't.
    it('answers an entry still offered as alreadyOffered though removed from its collection, and lets its expansions through (#1188)', async () => {
      arrange({
        collections: [owned('col-on', 'game-1', { deletedAt: removedAt }), owned('col-exp', 'game-exp')],
        entries: [listed('col-on', 'gl-on')],
        links: [{ baseGameId: 'game-1', expansionGameId: 'game-exp' }],
      });

      const results = await service.offerGames('event-1', 'att-1', {
        items: [{ collectionId: 'col-on', expansionCollectionIds: ['col-exp'] }],
      });

      expect(outcomes(results)).toEqual([
        ['col-on', 'alreadyOffered'],
        ['col-exp', 'added'],
      ]);
      expect(db.eventAttendeeGameList.create).toHaveBeenCalledTimes(1);
    });

    // The batch refuses this id as notFound; the single add answered 500.
    it("answers the single add's create that finds no collection entry to connect with 404, as the batch does (#1188)", async () => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('No record was found for a connect.', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' })).rejects.toThrow(
        new NotFoundException(t('errors.attendee.game_collection_entry_not_found', { collectionId: 'col-1' })),
      );
    });

    it("checks create on the attendee's offered games once, as the single add does (#1188)", async () => {
      arrange({ collections: [owned('col-1', 'game-1'), owned('col-2', 'game-2')] });

      await service.offerGames('event-1', 'att-1', { items: [{ collectionId: 'col-1' }, { collectionId: 'col-2' }] });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledTimes(1);
      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.create,
        ResourceType.EventAttendeeGameList,
        {
          attendeeId: 'att-1',
          attendee: { id: 'att-1', userId: 'user-1', eventId: 'event-1', event: { householdId: 'hh-1' } },
        },
      );
    });

    it('refuses before reading or writing when the instance check denies', async () => {
      arrange({ collections: [owned('col-1', 'game-1')] });
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.offerGames('event-1', 'att-1', { items: [{ collectionId: 'col-1' }] })).rejects.toThrow(
        ForbiddenException,
      );
      expect(db.gameCollection.findMany).not.toHaveBeenCalled();
      expect(db.eventAttendeeGameList.create).not.toHaveBeenCalled();
    });

    // The single add maps the shared judgement to the answers it always gave.
    it("keeps the single add's answers unchanged", async () => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);

      db.gameCollection.findUnique.mockResolvedValue(null);
      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' })).rejects.toThrow(
        NotFoundException,
      );
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-9', deletedAt: null } as GameCollection);
      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' })).rejects.toThrow(
        ForbiddenException,
      );
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: removedAt } as GameCollection);
      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' })).rejects.toThrow(
        BadRequestException,
      );
      db.gameCollection.findUnique.mockResolvedValue({ userId: 'user-1', deletedAt: null } as GameCollection);
      db.eventAttendeeGameList.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
      );
      await expect(service.addGameToList('event-1', 'att-1', { collectionId: 'col-1' })).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
