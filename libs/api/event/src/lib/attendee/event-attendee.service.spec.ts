import type { Event, EventAttendee, EventGame, GameCollection } from '@bge/database';
import { Action, EventParticipationStatus, NominationStatus, ResourceType, SystemRole } from '@bge/database';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEventAttendee,
  makeEventAttendeeGameList,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  GameRemovedFromEventEvent,
  NominationPausedEvent,
  NominationResumedEvent,
} from '../nomination/events/nomination.events';
import { lineupStillAhead } from './attendance';
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
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser'>>;
  let emitter: { emit: jest.Mock };
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    permissions = { invalidateUser: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventAttendeeService,
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

    // The writes run their statements on the transaction client; the mock
    // hands the callback the same delegates. Nothing is supplied from the
    // attendee's list unless a test says so.
    db.$transaction.mockImplementation((cb) => cb(db));
    db.eventGameNomination.updateManyAndReturn.mockResolvedValue([]);
    db.eventGame.findMany.mockResolvedValue([]);
  });

  /** The status write's row: an attendee of event-1 who has not been removed. */
  const attendeeRow = (overrides: Partial<EventAttendee> = {}) =>
    makeEventAttendee({ id: 'att-1', eventId: 'event-1', userId: 'user-1', ...overrides });

  afterEach(() => jest.clearAllMocks());

  describe('EventAttendee resource', () => {
    // #512. Unpaginated, so no envelope guard stands behind it (#373), but it
    // is a collection read and composes like one. The rows do not change: the
    // path's event was already the filter, and the ceiling still clips it.
    it('getAttendees asks the composer for its where clause, declaring the path event as its scope', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);

      await service.getAttendees('event-1');

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

      await service.getAttendees('event-1');

      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      );
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
        await service.removeAttendee('event-1', 'att-1');

        const [name, emitted] = emitter.emit.mock.calls[0];
        expect(name).toBe(AttendeeRemovedEvent.eventName);
        expect(emitted).toBeInstanceOf(AttendeeRemovedEvent);
        expect(emitted.action).toBe('update');
        expect(emitted.subjectId).toBe('att-1');
        expect(emitted.before).toEqual(expect.objectContaining({ id: 'att-1', eventId: 'event-1', removedAt: null }));
        expect(emitted.after).toEqual(expect.objectContaining({ id: 'att-1', eventId: 'event-1', removedAt }));
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
        status: 'Invited',
      } as EventAttendee);
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
        status: EventParticipationStatus.Attending,
      } as EventAttendee);
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

    // Their paused nominations return to the status each paused from; the
    // deleted scheduled games are not restored.
    it('updateStatus back to Attending resumes the paused nominations and deletes nothing', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({
        id: 'att-1',
        userId: 'user-1',
        status: EventParticipationStatus.NotAttending,
      } as EventAttendee);
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
        status: EventParticipationStatus.Invited,
      } as EventAttendee);
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

      await service.removeAttendee('event-1', 'att-1');

      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
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
        expect.objectContaining({ where: { eventId: 'event-1', userId: 'user-2', removedAt: { not: null } } }),
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
    // #512. Same shape as `getAttendees`: unpaginated, a collection read, and
    // scoped to the path's attendee, which was already its filter.
    it('getGameList asks the composer for its where clause, declaring the path attendee as its scope', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1', userId: 'user-1' } as EventAttendee);
      db.eventAttendeeGameList.findMany.mockResolvedValue([]);

      await service.getGameList('event-1', 'att-1');

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendeeGameList, Action.read, {
        attendeeId: 'att-1',
        removedAt: null,
      });
      expect(db.eventAttendeeGameList.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { attendeeId: 'att-1', removedAt: null, AND: [COND] } }),
      );
    });

    it('addGameToList emits a GameAddedToListEvent (create) for the new row', async () => {
      db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);
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
      db.eventAttendeeGameList.update.mockResolvedValue(makeEventAttendeeGameList('att-1', 'col-1', { id: 'gl-1' }));

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
      db.eventAttendeeGameList.create.mockResolvedValue(makeEventAttendeeGameList('att-1', 'col-1', { id: 'gl-1' }));

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

      it('counts what the entry supplies after locking it', async () => {
        await service.removeGameFromList('event-1', 'att-1', 'gl-1');

        expect(db.$queryRaw).toHaveBeenCalledTimes(1);
        expect(db.eventGameNomination.count).toHaveBeenCalledWith({
          where: {
            suppliedFromId: 'gl-1',
            status: { in: [NominationStatus.Open, NominationStatus.AwaitingApproval, NominationStatus.Paused] },
          },
        });
        expect(db.eventGame.count).toHaveBeenCalledWith({
          where: { suppliedById: 'gl-1', ...lineupStillAhead(expect.any(Date)) },
        });
        expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          db.eventGameNomination.count.mock.invocationCallOrder[0],
        );
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
});
