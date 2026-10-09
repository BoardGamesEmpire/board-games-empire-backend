import {
  Action,
  AvailabilityResponse,
  EventAvailabilityVote,
  EventOccurrence,
  EventParticipationStatus,
  EventSchedulingMode,
  OccurrenceStatus,
  Prisma,
  ResourceType,
  ScheduledGameRole,
} from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  makeEventAttendee,
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

/** A vote as the vote read selects it, with the occurrence it is matched back to. */
const vote = (id: string, occurrenceId: string) => ({
  id,
  occurrenceId,
  attendeeId: `att-${id}`,
  response: AvailabilityResponse.Available,
  attendee: { userId: `user-${id}` },
});

/** A game as the game read selects it, with the occurrence it is matched back to. */
const game = (id: string, occurrenceId: string) => ({
  id,
  occurrenceId,
  platformGameId: `pg-${id}`,
  role: ScheduledGameRole.Primary,
  platformGame: { id: `pg-${id}` },
});

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

    db.eventAvailabilityVote.findMany.mockResolvedValue([]);
    db.eventGame.findMany.mockResolvedValue([]);
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

  /**
   * #560. The occurrence reads embedded each occurrence's votes and games, so
   * both went to whoever could read the occurrence, a friend of the host or a
   * household guest included. Each vote names the attendee who cast it and
   * their user. Each is now a read of its own, with its type's ceiling in that
   * read's top-level `where`, the only place a deny-all ceiling is enforced
   * (#559).
   */
  describe('the votes and games on the occurrence reads', () => {
    beforeEach(() => {
      db.event.count.mockResolvedValue(1);
      db.eventOccurrence.findMany.mockResolvedValue([
        makeEventOccurrence({ id: 'occ-1', eventId: 'event-1' }),
        makeEventOccurrence({ id: 'occ-2', eventId: 'event-1' }),
      ]);
      db.eventOccurrence.count.mockResolvedValue(2);
    });

    it('takes the page and the occurrence by id with their policy alone embedded', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(makeEventOccurrence({ id: 'occ-1', eventId: 'event-1' }));

      await service.getOccurrences('event-1', paginationQuery({ limit: 10 }));
      await service.getOccurrence('event-1', 'occ-1');

      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: { policy: true } }));
      expect(db.eventOccurrence.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ include: { policy: true } }),
      );
    });

    it("reads the page's votes as their own read, composed with the vote ceiling, in the order they were cast", async () => {
      await service.getOccurrences('event-1', paginationQuery({ limit: 10 }));

      const occurrenceId = { in: ['occ-1', 'occ-2'] };
      expect(compose).toHaveBeenCalledWith(ResourceType.EventAvailabilityVote, Action.read, { occurrenceId });
      expect(db.eventAvailabilityVote.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { occurrenceId, AND: [COND] },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it("reads the page's games as their own read, composed with the event-game ceiling, in the host's order", async () => {
      await service.getOccurrences('event-1', paginationQuery({ limit: 10 }));

      const occurrenceId = { in: ['occ-1', 'occ-2'] };
      expect(compose).toHaveBeenCalledWith(ResourceType.EventGame, Action.read, { occurrenceId });
      expect(db.eventGame.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { occurrenceId, AND: [COND] },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it('reads the votes and games of the one occurrence asked for by id', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue(makeEventOccurrence({ id: 'occ-1', eventId: 'event-1' }));

      await service.getOccurrence('event-1', 'occ-1');

      const where = { occurrenceId: { in: ['occ-1'] }, AND: [COND] };
      expect(db.eventAvailabilityVote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(db.eventGame.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    });

    it('serves each vote and game under its occurrence, in the shape the embed had', async () => {
      db.eventAvailabilityVote.findMany.mockResolvedValue([vote('v1', 'occ-1'), vote('v2', 'occ-1')] as never);
      db.eventGame.findMany.mockResolvedValue([game('g1', 'occ-2')] as never);

      const { rows } = await service.getOccurrences('event-1', paginationQuery({ limit: 10 }));

      expect(rows.map(({ id, availabilityVotes, games }) => ({ id, availabilityVotes, games }))).toEqual([
        {
          id: 'occ-1',
          availabilityVotes: [
            {
              id: 'v1',
              attendeeId: 'att-v1',
              response: AvailabilityResponse.Available,
              attendee: { userId: 'user-v1' },
            },
            {
              id: 'v2',
              attendeeId: 'att-v2',
              response: AvailabilityResponse.Available,
              attendee: { userId: 'user-v2' },
            },
          ],
          games: [],
        },
        {
          id: 'occ-2',
          availabilityVotes: [],
          games: [
            { id: 'g1', platformGameId: 'pg-g1', role: ScheduledGameRole.Primary, platformGame: { id: 'pg-g1' } },
          ],
        },
      ]);
    });

    it('reads no votes or games for an empty page', async () => {
      db.eventOccurrence.findMany.mockResolvedValue([]);

      await service.getOccurrences('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventAvailabilityVote.findMany).not.toHaveBeenCalled();
      expect(db.eventGame.findMany).not.toHaveBeenCalled();
    });
  });

  /**
   * The writes answered with the votes and games embedded, so a caller who can
   * write an occurrence but not read its votes, an API key or a plugin granted
   * the write alone, got every voter. They answer through the same reads as
   * the read routes, under the same ceilings. The create reads for neither: a
   * new occurrence has none, and a read after its commit could only fail a
   * create that happened.
   */
  describe('the votes and games on the occurrence writes', () => {
    const writes = [
      { name: 'addOccurrence', op: 'create', status: OccurrenceStatus.Proposed },
      { name: 'updateOccurrence', op: 'update', status: OccurrenceStatus.Proposed },
      { name: 'confirmOccurrence', op: 'update', status: OccurrenceStatus.Proposed },
      { name: 'declineOccurrence', op: 'update', status: OccurrenceStatus.Proposed },
      { name: 'cancelOccurrence', op: 'update', status: OccurrenceStatus.Confirmed },
      { name: 'removeOccurrence', op: 'delete', status: OccurrenceStatus.Proposed },
    ] as const;

    const answeredThroughReads = writes.filter(({ name }) => name !== 'addOccurrence');

    const run = (name: (typeof writes)[number]['name']) => {
      switch (name) {
        case 'addOccurrence':
          return service.addOccurrence('event-1', { label: 'Day 1' });
        case 'updateOccurrence':
          return service.updateOccurrence('event-1', 'occ-1', { label: 'New' });
        default:
          return service[name]('event-1', 'occ-1');
      }
    };

    beforeEach(() => {
      const row = makeEventOccurrence({ id: 'occ-1', eventId: 'event-1' });
      db.event.findUnique.mockResolvedValue({
        id: 'event-1',
        schedulingMode: EventSchedulingMode.MultiDay,
        householdId: null,
      } as never);
      db.eventOccurrence.create.mockResolvedValue(row);
      db.eventOccurrence.update.mockResolvedValue(row);
      db.eventOccurrence.delete.mockResolvedValue(row);
      db.eventAvailabilityVote.findMany.mockResolvedValue([vote('v1', 'occ-1')] as never);
      db.eventGame.findMany.mockResolvedValue([game('g1', 'occ-1')] as never);
    });

    it.each(writes)('$name embeds the policy alone in its write', async ({ name, op, status }) => {
      db.eventOccurrence.findUnique.mockResolvedValue(makeEventOccurrence({ id: 'occ-1', eventId: 'event-1', status }));

      await run(name);

      expect(db.eventOccurrence[op]).toHaveBeenCalledWith(expect.objectContaining({ include: { policy: true } }));
    });

    it.each(answeredThroughReads)(
      '$name answers with the votes and games read under their own ceilings',
      async ({ name, status }) => {
        db.eventOccurrence.findUnique.mockResolvedValue(
          makeEventOccurrence({ id: 'occ-1', eventId: 'event-1', status }),
        );

        const answer = await run(name);

        const occurrenceId = { in: ['occ-1'] };
        expect(compose).toHaveBeenCalledWith(ResourceType.EventAvailabilityVote, Action.read, { occurrenceId });
        expect(compose).toHaveBeenCalledWith(ResourceType.EventGame, Action.read, { occurrenceId });
        expect(answer).toEqual(
          expect.objectContaining({
            id: 'occ-1',
            availabilityVotes: [
              {
                id: 'v1',
                attendeeId: 'att-v1',
                response: AvailabilityResponse.Available,
                attendee: { userId: 'user-v1' },
              },
            ],
            games: [
              { id: 'g1', platformGameId: 'pg-g1', role: ScheduledGameRole.Primary, platformGame: { id: 'pg-g1' } },
            ],
          }),
        );
      },
    );

    it('addOccurrence answers with no votes or games, and reads for neither', async () => {
      const answer = await service.addOccurrence('event-1', { label: 'Day 1' });

      expect(db.eventAvailabilityVote.findMany).not.toHaveBeenCalled();
      expect(db.eventGame.findMany).not.toHaveBeenCalled();
      expect(answer).toEqual(expect.objectContaining({ id: 'occ-1', availabilityVotes: [], games: [] }));
    });

    it('removeOccurrence reads the votes and games before the delete takes them with it', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.removeOccurrence('event-1', 'occ-1');

      const [deleted] = db.eventOccurrence.delete.mock.invocationCallOrder;
      expect(db.eventAvailabilityVote.findMany.mock.invocationCallOrder[0]).toBeLessThan(deleted);
      expect(db.eventGame.findMany.mock.invocationCallOrder[0]).toBeLessThan(deleted);
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

    // The route's policy check judges the vote by type alone, and an event
    // role is rendered once per attendance, so the vote grant from one event
    // passed a vote in any other the actor attends. The service checks the
    // vote against the attendee casting it, in this event.
    it('checks the vote against the attendee casting it, in the event in the path', async () => {
      db.eventAvailabilityVote.findUnique.mockResolvedValue(null);

      await service.submitAvailability('event-1', 'occ-1', { response: AvailabilityResponse.Available });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.create,
        ResourceType.EventAvailabilityVote,
        { occurrenceId: 'occ-1', attendeeId: 'att-1', attendee: { userId: 'user-1', eventId: 'event-1' } },
      );
    });

    it('refuses before writing when the instance check denies', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(
        service.submitAvailability('event-1', 'occ-1', { response: AvailabilityResponse.Available }),
      ).rejects.toThrow(ForbiddenException);
      expect(db.eventAvailabilityVote.upsert).not.toHaveBeenCalled();
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
      db.eventAvailabilityVote.findMany.mockResolvedValue([]);
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
    // here. They are a read of their own, with the ceiling in its top-level
    // `where`: nested in the occurrence read as an `include` filter, a
    // deny-all ceiling is dropped by Prisma rather than turned into no rows.
    it('composes the votes as a read of their own, declaring the path event as its scope', async () => {
      await service.getAvailabilitySummary('event-1');

      expect(compose).toHaveBeenCalledWith(ResourceType.EventAvailabilityVote, Action.read, {
        occurrence: { is: { eventId: 'event-1' } },
      });
      expect(db.eventAvailabilityVote.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { occurrence: { is: { eventId: 'event-1' } }, AND: [COND] } }),
      );
    });

    // Unmatched, a vote from an attendee the caller may not read counted in
    // `totalVotes` and `voters` but not in `eligibleVoters`: an API key that
    // may read one attendee read `eligibleVoters: 1` beside every vote cast,
    // and a `participationRate` above 1.
    it('counts only the votes of the attendees it counts, on the occurrences it returns', async () => {
      db.eventAttendee.findMany.mockResolvedValue([
        makeEventAttendee({
          id: 'att-1',
          eventId: 'event-1',
          userId: 'user-1',
          status: EventParticipationStatus.Attending,
        }),
      ]);
      db.eventOccurrence.findMany.mockResolvedValue([makeEventOccurrence({ id: 'occ-1', eventId: 'event-1' })]);
      db.eventAvailabilityVote.findMany.mockResolvedValue([
        { occurrenceId: 'occ-1', attendeeId: 'att-1', response: AvailabilityResponse.Available },
        // An attendee the attendee read did not return.
        { occurrenceId: 'occ-1', attendeeId: 'att-2', response: AvailabilityResponse.Unavailable },
        // An occurrence the occurrence read did not return.
        { occurrenceId: 'occ-2', attendeeId: 'att-1', response: AvailabilityResponse.Maybe },
      ] as EventAvailabilityVote[]);

      const summary = await service.getAvailabilitySummary('event-1');

      expect(summary.eligibleVoters).toBe(1);
      expect(summary.occurrences).toEqual([
        expect.objectContaining({
          occurrenceId: 'occ-1',
          available: 1,
          maybe: 0,
          unavailable: 0,
          totalVotes: 1,
          pendingVotes: 0,
          participationRate: 1,
          voters: [{ attendeeId: 'att-1', response: AvailabilityResponse.Available }],
        }),
      ]);
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
