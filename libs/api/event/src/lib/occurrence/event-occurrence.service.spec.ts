import {
  Action,
  AvailabilityResponse,
  EventAvailabilityVote,
  EventOccurrence,
  EventSchedulingMode,
  OccurrenceStatus,
  Prisma,
  ResourceType,
} from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEventOccurrence,
  paginationQuery,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OccurrenceEvents } from './constants';
import { EventOccurrenceService } from './event-occurrence.service';
import {
  AvailabilityVoteSubmittedEvent,
  OccurrenceAddedEvent,
  OccurrenceStatusChangedEvent,
  OccurrenceUpdatedEvent,
} from './events/occurrence.events';

const COND = { id: 'sentinel-condition' };

describe('EventOccurrenceService', () => {
  let service: EventOccurrenceService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let emitter: { emit: jest.Mock };
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventOccurrenceService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the reads actually run.
        ScopeComposer,
        { provide: EventEmitter2, useValue: emitter },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventOccurrenceService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
  });

  afterEach(() => jest.clearAllMocks());

  describe('getOccurrences', () => {
    beforeEach(() => {
      db.eventOccurrence.findMany.mockResolvedValue([]);
      db.eventOccurrence.count.mockResolvedValue(0);
    });

    // #512. `EventOccurrence` has left `PENDING_SCOPE_SWEEP`, so the envelope
    // fails with a 500 unless this read composes. The rows do not change: the
    // path's event was already the filter, and the ceiling still clips it.
    it('asks the composer for its where clause, declaring the path event as its scope', async () => {
      db.event.count.mockResolvedValue(1);

      await service.getOccurrences('event-1', paginationQuery({ limit: 10 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.EventOccurrence, Action.read, { eventId: 'event-1' });
      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1', AND: [COND] } }),
      );
    });

    it('throws NotFound when the event does not exist', async () => {
      db.event.count.mockResolvedValue(0);
      await expect(service.getOccurrences('missing', paginationQuery({ limit: 10 }))).rejects.toThrow(
        NotFoundException,
      );
    });

    // #372 paginates a read that used to return every occurrence of the event.
    it('takes one page rather than the whole event', async () => {
      db.event.count.mockResolvedValue(1);

      await service.getOccurrences('event-1', paginationQuery({ page: 2, limit: 5 }));

      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5, skip: 5 }));
    });

    /**
     * `sortOrder` is an `Int @default(0)`, so every occurrence nobody has
     * reordered shares a sort key. Paging a tie-less sort lets those rows drift
     * across page boundaries between requests, which is the defect page-based
     * paging turns from latent into visible.
     */
    it('breaks ties on id, so a shared sortOrder cannot drift across pages', async () => {
      db.event.count.mockResolvedValue(1);

      await service.getOccurrences('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
      );
    });

    it('counts through the same event-scoped where as the rows, in one REPEATABLE READ transaction', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventOccurrence.count.mockResolvedValue(7);

      const page = await service.getOccurrences('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventOccurrence.count).toHaveBeenCalledWith({ where: { eventId: 'event-1', AND: [COND] } });
      expect(page).toEqual({ rows: [], total: 7 });

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });
  });

  describe('getOccurrence', () => {
    it('filters by read conditions', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.getOccurrence('event-1', 'occ-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.read,
      );
      expect(db.eventOccurrence.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'occ-1', AND: [COND] }) }),
      );
    });

    it('throws NotFound when the occurrence is not visible', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventOccurrence.findUnique.mockResolvedValue(null);
      await expect(service.getOccurrence('event-1', 'occ-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('addOccurrence', () => {
    it('emits an OccurrenceAddedEvent with the created row snapshot', async () => {
      db.event.findUnique.mockResolvedValue({
        id: 'event-1',
        schedulingMode: EventSchedulingMode.MultiDay,
      } as never);
      db.eventOccurrence.create.mockResolvedValue(
        makeEventOccurrence({ id: 'occ-1', eventId: 'event-1', label: 'Day 1', status: OccurrenceStatus.Confirmed }),
      );

      await service.addOccurrence('event-1', { label: 'Day 1' });

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(OccurrenceAddedEvent.eventName);
      expect(emitted).toBeInstanceOf(OccurrenceAddedEvent);
      expect(emitted.action).toBe('create');
      expect(emitted.subjectId).toBe('occ-1');
      expect(emitted.before).toBeNull();
      expect(emitted.after).toEqual(
        expect.objectContaining({
          id: 'occ-1',
          eventId: 'event-1',
          label: 'Day 1',
          status: OccurrenceStatus.Confirmed,
        }),
      );
    });

    // The route's policy check judges a create by type alone, so the service
    // checks the row it is about to write: the event named in the path, and
    // that event's household for the household-bound grants.
    it('checks the create against the occurrence it is about to write', async () => {
      db.event.findUnique.mockResolvedValue({
        id: 'event-1',
        schedulingMode: EventSchedulingMode.MultiDay,
        householdId: 'hh-1',
      } as never);
      db.eventOccurrence.create.mockResolvedValue(makeEventOccurrence({ id: 'occ-1', eventId: 'event-1' }));

      await service.addOccurrence('event-1', { label: 'Day 1' });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.EventOccurrence, {
        eventId: 'event-1',
        event: { householdId: 'hh-1' },
      });
    });

    it('refuses before writing when the instance check denies', async () => {
      db.event.findUnique.mockResolvedValue({
        id: 'event-1',
        schedulingMode: EventSchedulingMode.MultiDay,
        householdId: null,
      } as never);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.addOccurrence('event-1', { label: 'Day 1' })).rejects.toThrow(ForbiddenException);
      expect(db.eventOccurrence.create).not.toHaveBeenCalled();
    });
  });

  describe('updateOccurrence', () => {
    it('filters by UPDATE conditions (tightened from read)', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);
      db.eventOccurrence.update.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.updateOccurrence('event-1', 'occ-1', { label: 'x' });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.update,
      );
      expect(db.eventOccurrence.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'occ-1', AND: [COND] }) }),
      );
    });

    it('emits an OccurrenceUpdatedEvent carrying the changed subset', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(
        makeEventOccurrence({ id: 'occ-1', eventId: 'event-1', label: 'Old' }),
      );
      db.eventOccurrence.update.mockResolvedValue(
        makeEventOccurrence({ id: 'occ-1', eventId: 'event-1', label: 'New' }),
      );

      await service.updateOccurrence('event-1', 'occ-1', { label: 'New' });

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(OccurrenceUpdatedEvent.eventName);
      expect(emitted).toBeInstanceOf(OccurrenceUpdatedEvent);
      expect(emitted.action).toBe('update');
      expect(emitted.subjectId).toBe('occ-1');
      expect(emitted.before).toEqual({ id: 'occ-1', label: 'Old' });
      expect(emitted.after).toEqual({ id: 'occ-1', label: 'New' });
    });

    it('rejects an empty patch', async () => {
      await expect(service.updateOccurrence('event-1', 'occ-1', {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('removeOccurrence', () => {
    it('filters by DELETE conditions', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);
      db.eventOccurrence.delete.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.removeOccurrence('event-1', 'occ-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.delete,
      );
    });
  });

  describe('status transitions', () => {
    it('confirmOccurrence filters by UPDATE conditions', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({
        id: 'occ-1',
        status: OccurrenceStatus.Proposed,
      } as EventOccurrence);
      db.eventOccurrence.update.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.confirmOccurrence('event-1', 'occ-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.update,
      );
    });

    it('confirmOccurrence emits an OccurrenceStatusChangedEvent under the Confirmed name', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({
        id: 'occ-1',
        status: OccurrenceStatus.Proposed,
      } as EventOccurrence);
      db.eventOccurrence.update.mockResolvedValue(
        makeEventOccurrence({ id: 'occ-1', eventId: 'event-1', status: OccurrenceStatus.Confirmed }),
      );

      await service.confirmOccurrence('event-1', 'occ-1');

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(OccurrenceEvents.OccurrenceConfirmed);
      expect(emitted).toBeInstanceOf(OccurrenceStatusChangedEvent);
      expect(emitted.action).toBe('update');
      expect(emitted.subjectId).toBe('occ-1');
      expect(emitted.before).toEqual({ id: 'occ-1', eventId: 'event-1', status: OccurrenceStatus.Proposed });
      expect(emitted.after).toEqual({ id: 'occ-1', eventId: 'event-1', status: OccurrenceStatus.Confirmed });
    });

    it('rejects an illegal source status', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({
        id: 'occ-1',
        status: OccurrenceStatus.Confirmed,
      } as EventOccurrence);
      await expect(service.confirmOccurrence('event-1', 'occ-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('submitAvailability', () => {
    beforeEach(() => {
      abilityService.getActingUserId.mockReturnValue('user-1');
      db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1' } as never);
      db.eventOccurrence.findUnique.mockResolvedValue({
        id: 'occ-1',
        status: OccurrenceStatus.Proposed,
      } as EventOccurrence);
      db.eventAvailabilityVote.upsert.mockResolvedValue({
        id: 'vote-1',
        occurrenceId: 'occ-1',
        attendeeId: 'att-1',
        response: AvailabilityResponse.Available,
      } as EventAvailabilityVote);
    });

    it('emits a create-shaped AvailabilityVoteSubmittedEvent on the first vote', async () => {
      db.eventAvailabilityVote.findUnique.mockResolvedValue(null);

      await service.submitAvailability('event-1', 'occ-1', { response: AvailabilityResponse.Available });

      const [name, emitted] = emitter.emit.mock.calls[0];
      expect(name).toBe(AvailabilityVoteSubmittedEvent.eventName);
      expect(emitted).toBeInstanceOf(AvailabilityVoteSubmittedEvent);
      expect(emitted.action).toBe('create');
      expect(emitted.subjectId).toBe('vote-1');
      expect(emitted.before).toBeNull();
      expect(emitted.after).toEqual({
        id: 'vote-1',
        occurrenceId: 'occ-1',
        attendeeId: 'att-1',
        response: AvailabilityResponse.Available,
      });
    });

    it('emits an update-shaped AvailabilityVoteSubmittedEvent on a re-vote', async () => {
      db.eventAvailabilityVote.findUnique.mockResolvedValue({
        id: 'vote-1',
        response: AvailabilityResponse.Maybe,
      } as EventAvailabilityVote);

      await service.submitAvailability('event-1', 'occ-1', { response: AvailabilityResponse.Available });

      const [, emitted] = emitter.emit.mock.calls[0];
      expect(emitted).toBeInstanceOf(AvailabilityVoteSubmittedEvent);
      expect(emitted.action).toBe('update');
      expect(emitted.before).toEqual({ id: 'vote-1', response: AvailabilityResponse.Maybe });
      expect(emitted.after).toEqual({ id: 'vote-1', response: AvailabilityResponse.Available });
    });
  });

  /**
   * #512. The summary counts three collections, and each composes its own
   * scope. The route's guard is type-level, `can(read, EventAvailabilityVote)`,
   * which every event role passes for ANY event, so the query is the only
   * place the path's event is bound to the caller's own.
   */
  describe('getAvailabilitySummary', () => {
    beforeEach(() => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);
      db.eventOccurrence.findMany.mockResolvedValue([]);
    });

    it('composes the occurrence half, declaring the path event as its scope', async () => {
      await service.getAvailabilitySummary('event-1');

      expect(compose).toHaveBeenCalledWith(ResourceType.EventOccurrence, Action.read, { eventId: 'event-1' });
      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1', AND: [COND] } }),
      );
    });

    // Before #512 this half filtered on `eventId` and ANDed no ceiling at all,
    // so an attendee of one event could read another event's attendance counts
    // (`total`, `registered`, `guests`, `byStatus`, `eligibleVoters`). With the
    // ceiling in, an event the caller holds no attendee rule for counts zero.
    it('composes the attendee half too, so its counts are clipped by the caller’s attendee ceiling', async () => {
      await service.getAvailabilitySummary('event-1');

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, { eventId: 'event-1' });
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read);
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1', AND: [COND] } }),
      );
    });

    // The votes are the route's own type and the third collection counted
    // here. Left to ride on the occurrence, they escaped the vote ceiling and
    // counted voters the attendee half had already clipped away: an API key
    // that may read one attendee read `eligibleVoters: 1` beside every vote
    // cast, and a `participationRate` above 1. Scoping them to the attendees
    // counted above keeps every number in the summary about the same people.
    it('composes the votes, scoped to the attendees counted above', async () => {
      await service.getAvailabilitySummary('event-1');

      const counted = { eventId: 'event-1', AND: [COND] };
      expect(compose).toHaveBeenCalledWith(ResourceType.EventAvailabilityVote, Action.read, {
        attendee: { is: counted },
      });
      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            availabilityVotes: {
              where: { attendee: { is: counted }, AND: [COND] },
              select: { response: true, attendeeId: true },
            },
          },
        }),
      );
    });
  });

  it('propagates the ForbiddenException raised on empty conditions', async () => {
    db.event.count.mockResolvedValue(1);
    abilityService.getCurrentResourceConditions.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.getOccurrences('event-1', paginationQuery({ limit: 10 }))).rejects.toThrow(ForbiddenException);
  });
});
