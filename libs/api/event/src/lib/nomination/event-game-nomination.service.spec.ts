import type {
  Event,
  EventAttendee,
  EventGame,
  EventGameNomination,
  EventGameVote,
  EventOccurrence,
  EventOccurrencePolicy,
  EventPolicy,
} from '@bge/database';
import {
  Action,
  EventParticipationStatus,
  GameAdditionMode,
  NominationStatus,
  Prisma,
  ResourceType,
  ScheduledGameRole,
  VoteEligibility,
  VoteType,
} from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  paginationQuery,
  rawQueryText,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { LockedSupplier } from '../attendee/attendance';
import { NominateGameDto } from './dto/nominate-game.dto';
import { EventGameNominationService } from './event-game-nomination.service';
import {
  GameAddedToEventEvent,
  NominationCreatedEvent,
  NominationResolvedEvent,
  NominationWithdrawnEvent,
  VoteCastEvent,
} from './events/nomination.events';

const COND = { id: 'sentinel-condition' };

describe('EventGameNominationService', () => {
  let service: EventGameNominationService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let emitter: { emit: jest.Mock };
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    abilityService.getActingUserId.mockReturnValue('user-1');
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventGameNominationService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the list actually runs.
        ScopeComposer,
        { provide: EventEmitter2, useValue: emitter },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventGameNominationService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
    db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1' } as EventAttendee);
    db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: null } as Event);

    // The writes run on the transaction client, which the mock hands back as
    // the same delegates; the paginated read still settles its array form.
    db.$transaction.mockImplementation(((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: MockDatabaseService) => Promise<unknown>)(db)) as never);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getNominations', () => {
    beforeEach(() => {
      db.event.count.mockResolvedValue(1);
      db.eventGameNomination.findMany.mockResolvedValue([]);
      db.eventGameNomination.count.mockResolvedValue(0);
    });

    // #512. `EventGameNomination` has left `PENDING_SCOPE_SWEEP`, so the
    // envelope fails with a 500 unless this read composes. The rows do not
    // change: the path's event was already the filter, and the ceiling still
    // clips it.
    it('asks the composer for its where clause, declaring the path event as its scope', async () => {
      await service.getNominations('event-1', paginationQuery({ limit: 10 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.EventGameNomination, Action.read, { eventId: 'event-1' });
      expect(db.eventGameNomination.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1', AND: [COND] } }),
      );
    });

    // #372 paginates a read that used to return every nomination on the event —
    // a set that grows with the attendees rather than being bounded by anything.
    it('takes one page rather than the whole event', async () => {
      await service.getNominations('event-1', paginationQuery({ page: 3, limit: 5 }));

      expect(db.eventGameNomination.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5, skip: 10 }));
    });

    // Nominations created in one transaction share a `createdAt`, so the sort
    // needs `id` to be total; without it those rows drift across page edges.
    it('breaks ties on id, so nominations sharing a createdAt cannot drift', async () => {
      await service.getNominations('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventGameNomination.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
    });

    it('counts through the same event-scoped where as the rows, in one REPEATABLE READ transaction', async () => {
      db.eventGameNomination.count.mockResolvedValue(4);

      const page = await service.getNominations('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventGameNomination.count).toHaveBeenCalledWith({ where: { eventId: 'event-1', AND: [COND] } });
      expect(page).toEqual({ rows: [], total: 4 });

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });
  });

  it('getNomination → read', async () => {
    db.event.count.mockResolvedValue(1);
    db.eventGameNomination.findUnique.mockResolvedValue(nominationRow());

    await service.getNomination('event-1', 'nom-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.EventGameNomination,
      Action.read,
    );
  });

  // A vote that does not count is still served, so everyone sees how its
  // voter voted, and that it does not count. Whether it counts is worked out
  // from the voter as they are now, under the event's rule.
  describe('which votes count, as the reads serve them', () => {
    beforeEach(() => db.event.count.mockResolvedValue(1));

    it('marks each vote by whether its voter is eligible now, and serves no voter state', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        nominationRow({
          votes: [
            voteRow('vote-in', voter(EventParticipationStatus.Attending)),
            voteRow('vote-declined', voter(EventParticipationStatus.NotAttending)),
            voteRow('vote-invited', voter(EventParticipationStatus.Invited)),
            voteRow('vote-removed', voter(EventParticipationStatus.Attending, new Date())),
          ],
        }),
      );

      // No policy row: the event's default rule, ConfirmedOnly.
      const nomination = await service.getNomination('event-1', 'nom-1');

      expect(nomination.votes).toEqual([
        {
          id: 'vote-in',
          attendeeId: 'att-vote-in',
          voteType: VoteType.For,
          priority: null,
          comment: null,
          eligible: true,
        },
        expect.objectContaining({ id: 'vote-declined', eligible: false }),
        expect.objectContaining({ id: 'vote-invited', eligible: false }),
        expect.objectContaining({ id: 'vote-removed', eligible: false }),
      ]);
    });

    it("judges a date's nomination by that date's rule where it sets one", async () => {
      db.eventPolicy.findUnique.mockResolvedValue({ voteEligibility: VoteEligibility.ConfirmedOnly } as EventPolicy);
      db.eventOccurrencePolicy.findMany.mockResolvedValue([
        { occurrenceId: 'occ-1', voteEligibility: VoteEligibility.AllAttendees } as EventOccurrencePolicy,
      ]);
      db.eventGameNomination.findUnique.mockResolvedValue(
        nominationRow({ occurrenceId: 'occ-1', votes: [voteRow('vote-1', voter(EventParticipationStatus.Invited))] }),
      );

      const nomination = await service.getNomination('event-1', 'nom-1');

      expect(db.eventOccurrencePolicy.findMany).toHaveBeenCalledWith({ where: { occurrenceId: { in: ['occ-1'] } } });
      expect(nomination.votes).toEqual([expect.objectContaining({ id: 'vote-1', eligible: true })]);
    });
  });

  // The resolver counts only the votes of eligible voters, and its pool is
  // the attendees no host has removed. Each voter is judged as the pool reads
  // them, so the votes and the pool can't disagree about who is in.
  it('resolveNomination judges each voter as its pool reads them: a voter who left or was removed counts in neither', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue(openNomination());
    db.eventGameVote.findMany.mockResolvedValue([
      { voteType: VoteType.Against, attendeeId: 'att-in' },
      { voteType: VoteType.For, attendeeId: 'att-left' },
      { voteType: VoteType.For, attendeeId: 'att-removed' },
    ] as never);
    db.eventAttendee.findMany.mockResolvedValue([
      { id: 'att-in', ...voter(EventParticipationStatus.Attending) },
      { id: 'att-left', ...voter(EventParticipationStatus.NotAttending) },
    ] as never);
    mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.Open });
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Failed }));

    const { resolution } = await service.resolveNomination('event-1', 'nom-1');

    expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: 'event-1', removedAt: null } }),
    );
    expect(resolution.tally.totalVotes).toBe(1);
    expect(resolution.status).toBe(NominationStatus.Failed);
    expect(db.eventGame.create).not.toHaveBeenCalled();
  });

  // A vote is written under a share lock on its nomination, so votes read
  // after the nomination's own lock are every vote it settles on: none can
  // land between the count and the settle.
  it("resolveNomination counts the votes and the pool under the nomination's lock", async () => {
    db.eventGameNomination.findUnique.mockResolvedValue(openNomination());
    db.eventGameVote.findMany.mockResolvedValue([{ voteType: VoteType.Against, attendeeId: 'att-in' }] as never);
    db.eventAttendee.findMany.mockResolvedValue([
      { id: 'att-in', ...voter(EventParticipationStatus.Attending) },
    ] as never);
    mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.Open });
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Failed }));

    await service.resolveNomination('event-1', 'nom-1');

    const [, , nominationLock] = db.$queryRaw.mock.invocationCallOrder;
    const [votesRead] = db.eventGameVote.findMany.mock.invocationCallOrder;
    const [poolRead] = db.eventAttendee.findMany.mock.invocationCallOrder;
    const [settled] = db.eventGameNomination.update.mock.invocationCallOrder;

    expect(db.eventGameVote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventGameNominationId: 'nom-1' } }),
    );
    expect(votesRead).toBeGreaterThan(nominationLock);
    expect(poolRead).toBeGreaterThan(nominationLock);
    expect(settled).toBeGreaterThan(Math.max(votesRead, poolRead));
  });

  it('resolveNomination adds a nomination that passes to the lineup, and emits NominationResolved then GameAddedToEvent', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue(openNomination());
    db.eventGameVote.findMany.mockResolvedValue([{ voteType: VoteType.For, attendeeId: 'att-in' }] as never);
    db.eventAttendee.findMany.mockResolvedValue([
      { id: 'att-in', ...voter(EventParticipationStatus.Attending) },
    ] as never);
    mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.Open });
    db.eventGameNomination.update.mockResolvedValue(
      nominationRow({ nominatedById: 'att-nominator', status: NominationStatus.Passed }),
    );
    db.eventGame.create.mockResolvedValue({ id: 'eg-1', nominationId: 'nom-1' } as EventGame);

    const { resolution } = await service.resolveNomination('event-1', 'nom-1');

    expect(resolution.status).toBe(NominationStatus.Passed);
    expect(db.eventGame.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: { connect: { id: 'event-1' } },
        nomination: { connect: { id: 'nom-1' } },
        suppliedBy: { connect: { id: 'gl-1' } },
      }),
    });

    const [resolvedName, resolvedEvent] = emitter.emit.mock.calls[0];
    expect(resolvedName).toBe(NominationResolvedEvent.eventName);
    expect(resolvedEvent.elevatedToEventGameId).toBe('eg-1');
    expect(resolvedEvent.after).toEqual(expect.objectContaining({ id: 'nom-1', status: NominationStatus.Passed }));

    const [gameName, gameEvent] = emitter.emit.mock.calls[1];
    expect(gameName).toBe(GameAddedToEventEvent.eventName);
    expect(gameEvent.subjectId).toBe('eg-1');
    expect(gameEvent.addedByAttendeeId).toBe('att-nominator');
  });

  // The status is first checked outside the transaction; the supplier leaving
  // in between pauses the nomination, so it is checked again under its lock,
  // before anything is counted.
  it('resolveNomination answers 400 for a nomination that paused after it was read, and counts and writes nothing', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue(openNomination());
    mockSettleLocks(db, lockedSupplier({ status: EventParticipationStatus.NotAttending }), {
      status: NominationStatus.Paused,
    });

    await expect(service.resolveNomination('event-1', 'nom-1')).rejects.toThrow(BadRequestException);
    expect(db.eventGameVote.findMany).not.toHaveBeenCalled();
    expect(db.eventGameNomination.update).not.toHaveBeenCalled();
    expect(db.eventGame.create).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  // Removing a date clears it from the nominations that name it while
  // holding the date's row, and a settle adding the game to that date waits
  // on the same row. Both lock the event's dates first, so they take turns,
  // and a settle that comes second reads the date as the removal left it.
  describe("settling a nomination, against a write to the event's dates", () => {
    const settles = [
      {
        caller: 'resolveNomination',
        status: NominationStatus.Open,
        settle: () => service.resolveNomination('event-1', 'nom-1'),
      },
      {
        caller: 'hostApprove',
        status: NominationStatus.AwaitingApproval,
        settle: () => service.hostApprove('event-1', 'nom-1'),
      },
    ];

    /**
     * A nomination of a date, occ-1, as first read, that passes when it
     * settles, and names `lockedOccurrenceId` when read under its lock.
     */
    const arrange = (status: NominationStatus, lockedOccurrenceId: string | null) => {
      db.eventGameNomination.findUnique.mockResolvedValue({
        id: 'nom-1',
        status,
        platformGameId: 'pg-1',
        occurrenceId: 'occ-1',
        suppliedFromId: 'gl-1',
      } as EventGameNomination);
      db.eventGameVote.findMany.mockResolvedValue([{ voteType: VoteType.For, attendeeId: 'att-in' }] as never);
      db.eventAttendee.findMany.mockResolvedValue([
        { id: 'att-in', ...voter(EventParticipationStatus.Attending) },
      ] as never);
      mockSettleLocks(db, lockedSupplier(), { status, occurrenceId: lockedOccurrenceId });
      db.eventGameNomination.update.mockResolvedValue(
        nominationRow({ status: NominationStatus.Passed, occurrenceId: lockedOccurrenceId }),
      );
      db.eventGame.create.mockResolvedValue({ id: 'eg-1' } as EventGame);
      db.eventOccurrencePolicy.findMany.mockResolvedValue([]);
    };

    it.each(settles)(
      "$caller locks the event's dates after the supplier, before the nomination",
      async ({ status, settle }) => {
        arrange(status, 'occ-1');

        await settle();

        expect(db.$queryRaw).toHaveBeenCalledTimes(3);
        const [[supplierLock], [datesLock], [nominationLock]] = db.$queryRaw.mock.calls;
        expect(rawQueryText(supplierLock)).toMatch(/FROM attendee_game_lists/);
        expect(rawQueryText(datesLock)).toMatch(/^SELECT id FROM events WHERE id = \? FOR SHARE$/);
        expect((datesLock as unknown as Prisma.Sql).values).toEqual(['event-1']);
        expect(rawQueryText(nominationLock)).toMatch(/FROM event_game_nominations WHERE id = \? FOR UPDATE$/);
      },
    );

    it.each(settles)(
      'adds the game to the lineup of the date the nomination names under its lock, through $caller',
      async ({ status, settle }) => {
        arrange(status, 'occ-1');

        await settle();

        expect(db.eventGame.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ occurrence: { connect: { id: 'occ-1' } }, event: undefined }),
        });
      },
    );

    it.each(settles)(
      "adds the game to the event's own lineup when the nomination's date was removed after it was read, through $caller",
      async ({ status, settle }) => {
        arrange(status, null);

        await settle();

        expect(db.eventGame.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ event: { connect: { id: 'event-1' } }, occurrence: undefined }),
        });
      },
    );

    // The date's rule counts an invited attendee's vote, and the event's does
    // not, so the outcome shows whose rule counted it.
    it.each([
      { rule: 'the rule of the date it still names', lockedOccurrenceId: 'occ-1', outcome: NominationStatus.Passed },
      {
        rule: "the event's rule when its date was removed after it was read",
        lockedOccurrenceId: null,
        outcome: NominationStatus.Failed,
      },
    ])('resolveNomination counts the votes under $rule', async ({ lockedOccurrenceId, outcome }) => {
      db.eventPolicy.findUnique.mockResolvedValue({ voteEligibility: VoteEligibility.ConfirmedOnly } as EventPolicy);
      db.eventOccurrencePolicy.findUnique.mockResolvedValue({
        occurrenceId: 'occ-1',
        voteEligibility: VoteEligibility.AllAttendees,
      } as EventOccurrencePolicy);
      arrange(NominationStatus.Open, lockedOccurrenceId);
      db.eventAttendee.findMany.mockResolvedValue([
        { id: 'att-in', ...voter(EventParticipationStatus.Invited) },
      ] as never);

      const { resolution } = await service.resolveNomination('event-1', 'nom-1');

      expect(resolution.status).toBe(outcome);
      const [, , nominationLock] = db.$queryRaw.mock.invocationCallOrder;
      const [policyRead] = db.eventPolicy.findUnique.mock.invocationCallOrder;
      expect(policyRead).toBeGreaterThan(nominationLock);
    });
  });

  it('withdraw → update', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      nominatedById: 'att-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Withdrawn }));

    await service.withdraw('event-1', 'nom-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.EventGameNomination,
      Action.update,
    );
    expect(db.eventGameNomination.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'nom-1', AND: [COND] }) }),
    );
  });

  it('withdraw emits a NominationWithdrawnEvent carrying the status transition', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      nominatedById: 'att-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Withdrawn }));

    await service.withdraw('event-1', 'nom-1');

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(NominationWithdrawnEvent.eventName);
    expect(emitted).toBeInstanceOf(NominationWithdrawnEvent);
    expect(emitted.action).toBe('update');
    expect(emitted.subjectId).toBe('nom-1');
    expect(emitted.before).toEqual({ id: 'nom-1', eventId: 'event-1', status: NominationStatus.Open });
    expect(emitted.after).toEqual({ id: 'nom-1', eventId: 'event-1', status: NominationStatus.Withdrawn });
  });

  // A paused nomination is still its nominator's to pull, whoever supplies
  // it, so a game whose supplier left can still come off their list.
  it('withdraw accepts a paused nomination, and forgets the status it paused from', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      nominatedById: 'att-1',
      status: NominationStatus.Paused,
    } as EventGameNomination);
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Withdrawn }));

    await service.withdraw('event-1', 'nom-1');

    expect(db.eventGameNomination.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: NominationStatus.Withdrawn, pausedFrom: null } }),
    );
  });

  it('withdraw forbids a non-nominator', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      nominatedById: 'someone-else',
      status: NominationStatus.Open,
    } as EventGameNomination);

    await expect(service.withdraw('event-1', 'nom-1')).rejects.toThrow(ForbiddenException);
  });

  describe('hostApprove', () => {
    beforeEach(() => {
      db.eventGameNomination.findUnique.mockResolvedValue({
        id: 'nom-1',
        status: NominationStatus.AwaitingApproval,
        platformGameId: 'pg-1',
        occurrenceId: null,
        suppliedFromId: 'gl-1',
      } as EventGameNomination);
    });

    it('→ update', async () => {
      mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.AwaitingApproval });
      db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Approved }));
      db.eventGame.create.mockResolvedValue({ id: 'eg-1' } as EventGame);

      await service.hostApprove('event-1', 'nom-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventGameNomination,
        Action.update,
      );
    });

    // The status was read before the transaction; the supplier leaving in
    // between pauses the nomination, so it is checked again under its lock.
    it('answers 400 for a nomination that paused after it was read, and writes nothing', async () => {
      mockSettleLocks(db, lockedSupplier({ status: EventParticipationStatus.NotAttending }), {
        status: NominationStatus.Paused,
      });

      await expect(service.hostApprove('event-1', 'nom-1')).rejects.toThrow(BadRequestException);
      expect(db.eventGameNomination.update).not.toHaveBeenCalled();
      expect(db.eventGame.create).not.toHaveBeenCalled();
    });

    it('refuses to add the game of a supplier who is not attending to the lineup, and writes nothing', async () => {
      mockSettleLocks(db, lockedSupplier({ status: EventParticipationStatus.NotAttending }), {
        status: NominationStatus.AwaitingApproval,
      });

      await expect(service.hostApprove('event-1', 'nom-1')).rejects.toThrow(ConflictException);
      expect(db.eventGameNomination.update).not.toHaveBeenCalled();
      expect(db.eventGame.create).not.toHaveBeenCalled();
    });
  });

  it('hostApprove emits NominationResolved (update) and then GameAddedToEvent (create)', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.AwaitingApproval,
      platformGameId: 'pg-1',
      occurrenceId: null,
      suppliedFromId: 'gl-1',
    } as EventGameNomination);
    mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.AwaitingApproval });
    db.eventGameNomination.update.mockResolvedValue(
      nominationRow({ nominatedById: 'att-nominator', status: NominationStatus.Approved }),
    );
    db.eventGame.create.mockResolvedValue({
      id: 'eg-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      suppliedById: 'gl-1',
      nominationId: 'nom-1',
      addedById: null,
      role: ScheduledGameRole.Primary,
    } as EventGame);

    await service.hostApprove('event-1', 'nom-1');

    const [gameName, gameEvent] = emitter.emit.mock.calls[1];
    expect(gameName).toBe(GameAddedToEventEvent.eventName);
    expect(gameEvent).toBeInstanceOf(GameAddedToEventEvent);
    expect(gameEvent.action).toBe('create');
    expect(gameEvent.subjectId).toBe('eg-1');
    expect(gameEvent.eventId).toBe('event-1');
    // Row addedById is null for elevated games — the nominator arrives as context.
    expect(gameEvent.addedByAttendeeId).toBe('att-nominator');
    expect(gameEvent.after).toEqual(
      expect.objectContaining({ id: 'eg-1', platformGameId: 'pg-1', nominationId: 'nom-1', addedById: null }),
    );

    const [resolvedName, resolvedEvent] = emitter.emit.mock.calls[0];
    expect(resolvedName).toBe(NominationResolvedEvent.eventName);
    expect(resolvedEvent).toBeInstanceOf(NominationResolvedEvent);
    expect(resolvedEvent.action).toBe('update');
    expect(resolvedEvent.subjectId).toBe('nom-1');
    expect(resolvedEvent.elevatedToEventGameId).toBe('eg-1');
    expect(resolvedEvent.before).toEqual(
      expect.objectContaining({ id: 'nom-1', status: NominationStatus.AwaitingApproval }),
    );
    expect(resolvedEvent.after).toEqual(expect.objectContaining({ id: 'nom-1', status: NominationStatus.Approved }));
  });

  it('hostReject settles the nomination, adds nothing to the lineup, and emits only NominationResolved', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.AwaitingApproval,
      platformGameId: 'pg-1',
      occurrenceId: null,
      suppliedFromId: 'gl-1',
    } as EventGameNomination);
    mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.AwaitingApproval });
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Rejected }));

    await service.hostReject('event-1', 'nom-1');

    expect(db.eventGameNomination.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: NominationStatus.Rejected } }),
    );
    expect(db.eventGame.create).not.toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledTimes(1);

    const [resolvedName, resolvedEvent] = emitter.emit.mock.calls[0];
    expect(resolvedName).toBe(NominationResolvedEvent.eventName);
    expect(resolvedEvent.elevatedToEventGameId).toBeNull();
    expect(resolvedEvent.after).toEqual(expect.objectContaining({ id: 'nom-1', status: NominationStatus.Rejected }));
  });

  it('resolveNomination rejects a non-Open nomination', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      eventId: 'event-1',
      status: NominationStatus.Passed,
      platformGameId: 'pg-1',
      occurrenceId: null,
      releaseId: null,
      votingDeadline: null,
      nominatedById: 'att-1',
      suppliedFromId: 'gl-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as EventGameNomination);

    await expect(service.resolveNomination('event-1', 'nom-1')).rejects.toThrow(BadRequestException);
  });

  it('castVote emits a create-shaped VoteCastEvent on the first vote', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.$queryRaw.mockResolvedValue([{ status: NominationStatus.Open }] as never);
    db.eventGameVote.findUnique.mockResolvedValue(null);
    db.eventGameVote.upsert.mockResolvedValue({
      id: 'vote-1',
      eventGameNominationId: 'nom-1',
      attendeeId: 'att-1',
      voteType: VoteType.For,
      priority: null,
      comment: null,
    } as EventGameVote);

    await service.castVote('event-1', 'nom-1', { voteType: VoteType.For });

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(VoteCastEvent.eventName);
    expect(emitted).toBeInstanceOf(VoteCastEvent);
    expect(emitted.action).toBe('create');
    expect(emitted.subjectId).toBe('vote-1');
    expect(emitted.before).toBeNull();
    expect(emitted.after).toEqual({
      id: 'vote-1',
      eventGameNominationId: 'nom-1',
      attendeeId: 'att-1',
      voteType: VoteType.For,
      priority: null,
      comment: null,
    });
  });

  it('castVote emits an update-shaped VoteCastEvent on a changed vote', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.$queryRaw.mockResolvedValue([{ status: NominationStatus.Open }] as never);
    db.eventGameVote.findUnique.mockResolvedValue({
      id: 'vote-1',
      voteType: VoteType.Against,
      priority: null,
      comment: null,
    } as EventGameVote);
    db.eventGameVote.upsert.mockResolvedValue({
      id: 'vote-1',
      eventGameNominationId: 'nom-1',
      attendeeId: 'att-1',
      voteType: VoteType.For,
      priority: null,
      comment: null,
    } as EventGameVote);

    await service.castVote('event-1', 'nom-1', { voteType: VoteType.For });

    const [, emitted] = emitter.emit.mock.calls[0];
    expect(emitted).toBeInstanceOf(VoteCastEvent);
    expect(emitted.action).toBe('update');
    expect(emitted.before).toEqual({ id: 'vote-1', voteType: VoteType.Against, priority: null, comment: null });
    expect(emitted.after).toEqual({ id: 'vote-1', voteType: VoteType.For, priority: null, comment: null });
  });

  // The route's policy check judges the vote by type alone, and an event role
  // is rendered once per attendance, so the vote grant from one event passed
  // a vote in any other the actor attends. The service checks the vote
  // against the attendee casting it, in this event.
  it('castVote checks the vote against the attendee casting it, in the event in the path', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.$queryRaw.mockResolvedValue([{ status: NominationStatus.Open }] as never);
    db.eventGameVote.upsert.mockResolvedValue({ id: 'vote-1' } as EventGameVote);

    await service.castVote('event-1', 'nom-1', { voteType: VoteType.For });

    expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.EventGameVote, {
      eventGameNominationId: 'nom-1',
      attendeeId: 'att-1',
      attendee: { userId: 'user-1', eventId: 'event-1' },
    });
  });

  // A supplier leaving pauses the nomination in their own transaction, which
  // can land between the first status check and the vote. The re-check under
  // the share lock sees it.
  it('castVote refuses a nomination that paused after the first check, and writes nothing', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.$queryRaw.mockResolvedValue([{ status: NominationStatus.Paused }] as never);

    await expect(service.castVote('event-1', 'nom-1', { voteType: VoteType.For })).rejects.toThrow(BadRequestException);
    expect(db.eventGameVote.upsert).not.toHaveBeenCalled();
  });

  it('castVote refuses before writing when the instance check denies', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    abilityService.assertCurrentActorCan.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.castVote('event-1', 'nom-1', { voteType: VoteType.For })).rejects.toThrow(ForbiddenException);
    expect(db.eventGameVote.upsert).not.toHaveBeenCalled();
  });

  it('nominate does not filter by abilities', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: 'RequiresVote',
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);

    db.eventGameNomination.create.mockResolvedValue(nominationRow());

    await service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto);

    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
  });

  // The route's policy check judges a create by type alone, so each create
  // path checks the row it is about to write: the event named in the path,
  // and that event's household for the household-bound grants.
  it('nominate checks the create against the nomination it is about to write', async () => {
    db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: 'hh-1' } as Event);
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: 'RequiresVote',
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGameNomination.create.mockResolvedValue(nominationRow());

    await service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto);

    expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.EventGameNomination, {
      eventId: 'event-1',
      event: { householdId: 'hh-1' },
    });
  });

  // The effective policy is read through the occurrence and a Direct-mode
  // nomination is elevated under it, so the occurrence must be this event's.
  it("nominate resolves an occurrence-level nomination's occurrence within the event", async () => {
    db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: 'RequiresVote',
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGameNomination.create.mockResolvedValue(nominationRow());

    await service.nominate('event-1', {
      platformGameId: 'pg-1',
      suppliedFromId: 'gl-1',
      occurrenceId: 'occ-1',
    } as NominateGameDto);

    expect(db.eventOccurrence.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'occ-1', eventId: 'event-1' } }),
    );
    expect(db.eventGameNomination.create).toHaveBeenCalled();
  });

  it('nominate answers not found for an occurrence outside the event, reading no policy and writing nothing', async () => {
    db.eventOccurrence.findUnique.mockResolvedValue(null);

    await expect(
      service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1', occurrenceId: 'occ-9' } as never),
    ).rejects.toThrow(NotFoundException);
    expect(db.eventOccurrencePolicy.findUnique).not.toHaveBeenCalled();
    expect(db.eventGameNomination.create).not.toHaveBeenCalled();
  });

  // Someone not attending supplies no game, and an entry or an attendee
  // that was removed is no supplier at all: each answers before the write.
  describe('nominate, on a supplier that cannot supply', () => {
    beforeEach(() => {
      db.eventPolicy.findUnique.mockResolvedValue({
        gameAdditionMode: 'RequiresVote',
        votingWindowHours: null,
      } as EventPolicy);
    });

    it.each([
      ['whose attendee is not attending', { status: EventParticipationStatus.NotAttending }, ConflictException],
      ['whose attendee a host removed', { attendeeRemovedAt: new Date() }, NotFoundException],
      ['taken off the list', { entryRemovedAt: new Date() }, NotFoundException],
      ['of another event', { eventId: 'event-9' }, NotFoundException],
    ])('refuses an entry %s, and writes nothing', async (_what, overrides, refusal) => {
      db.$queryRaw.mockResolvedValueOnce([lockedSupplier(overrides)] as never);

      await expect(
        service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto),
      ).rejects.toThrow(refusal);
      expect(db.eventGameNomination.create).not.toHaveBeenCalled();
    });

    it('answers not found for an entry that does not exist, and writes nothing', async () => {
      db.$queryRaw.mockResolvedValueOnce([] as never);

      await expect(
        service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-9' } as NominateGameDto),
      ).rejects.toThrow(NotFoundException);
      expect(db.eventGameNomination.create).not.toHaveBeenCalled();
    });
  });

  it('nominate refuses before writing when the instance check denies', async () => {
    abilityService.assertCurrentActorCan.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(
      service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto),
    ).rejects.toThrow(ForbiddenException);
    expect(db.eventGameNomination.create).not.toHaveBeenCalled();
  });

  it('directAddGame binds an event-level add to the event in the path and its household', async () => {
    db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: 'hh-1' } as Event);
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGame.create.mockResolvedValue({ id: 'eg-1', eventId: 'event-1' } as EventGame);

    await service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never);

    expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.EventGame, {
      eventId: 'event-1',
      occurrenceId: null,
      event: { householdId: 'hh-1' },
      occurrence: null,
    });
  });

  // An occurrence-level EventGame carries no eventId of its own: its event is
  // the occurrence's, so the occurrence is resolved within the event first and
  // the subject is built from what was found, not from what was claimed.
  it('directAddGame binds an occurrence-level add through the occurrence, resolved within the event', async () => {
    db.event.findUnique.mockResolvedValue({ id: 'event-1', householdId: 'hh-1' } as Event);
    db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGame.create.mockResolvedValue({ id: 'eg-1', occurrenceId: 'occ-1' } as EventGame);

    await service.directAddGame('event-1', {
      platformGameId: 'pg-1',
      suppliedById: 'gl-1',
      occurrenceId: 'occ-1',
    } as never);

    expect(db.eventOccurrence.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'occ-1', eventId: 'event-1' } }),
    );
    expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.EventGame, {
      eventId: null,
      occurrenceId: 'occ-1',
      event: null,
      occurrence: { id: 'occ-1', eventId: 'event-1', event: { householdId: 'hh-1' } },
    });
  });

  it('directAddGame answers not found for an occurrence outside the event, and writes nothing', async () => {
    db.eventOccurrence.findUnique.mockResolvedValue(null);

    await expect(
      service.directAddGame('event-1', {
        platformGameId: 'pg-1',
        suppliedById: 'gl-1',
        occurrenceId: 'occ-9',
      } as never),
    ).rejects.toThrow(NotFoundException);
    expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
    expect(db.eventGame.create).not.toHaveBeenCalled();
  });

  it('directAddGame refuses before writing when the instance check denies', async () => {
    abilityService.assertCurrentActorCan.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(
      service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(db.eventGame.create).not.toHaveBeenCalled();
  });

  // The supplier is the attendee recorded as bringing the game, so it has to
  // be a list entry of this event's, and for this game — the two checks a
  // nomination makes on the same field.
  it('directAddGame answers not found for a supplier from another event, and writes nothing', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier({ eventId: 'event-9' })] as never);

    await expect(
      service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-9' } as never),
    ).rejects.toThrow(NotFoundException);
    expect(db.eventGame.create).not.toHaveBeenCalled();
  });

  it('directAddGame refuses a supplier whose list entry is for another game, and writes nothing', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier({ platformGameId: 'pg-2' })] as never);

    await expect(
      service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(db.eventGame.create).not.toHaveBeenCalled();
  });

  it('nominate emits a NominationCreatedEvent with the created row snapshot', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: 'RequiresVote',
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGameNomination.create.mockResolvedValue(nominationRow());

    await service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto);

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(NominationCreatedEvent.eventName);
    expect(emitted).toBeInstanceOf(NominationCreatedEvent);
    expect(emitted.action).toBe('create');
    expect(emitted.subjectId).toBe('nom-1');
    expect(emitted.before).toBeNull();
    expect(emitted.after).toEqual({
      id: 'nom-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      nominatedById: 'att-1',
      suppliedFromId: 'gl-1',
      status: NominationStatus.Open,
      votingDeadline: null,
    });
  });

  // A Direct-mode nomination passes as it is made, and its game joins the
  // lineup in the transaction that vouched for its supplier.
  it('nominate under Direct adds the game to the lineup, and emits NominationCreated then GameAddedToEvent', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGameNomination.create.mockResolvedValue(nominationRow({ status: NominationStatus.Passed }));
    db.eventGame.create.mockResolvedValue({ id: 'eg-1', nominationId: 'nom-1' } as EventGame);

    await service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto);

    expect(db.eventGameNomination.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: NominationStatus.Passed }) }),
    );
    expect(db.eventGame.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: { connect: { id: 'event-1' } },
        nomination: { connect: { id: 'nom-1' } },
        suppliedBy: { connect: { id: 'gl-1' } },
      }),
    });

    expect(emitter.emit.mock.calls.map(([name]) => name)).toEqual([
      NominationCreatedEvent.eventName,
      GameAddedToEventEvent.eventName,
    ]);
    const [, gameEvent] = emitter.emit.mock.calls[1];
    expect(gameEvent.subjectId).toBe('eg-1');
    expect(gameEvent.addedByAttendeeId).toBe('att-1');
  });

  it('directAddGame emits a GameAddedToEventEvent with the acting attendee as context', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGame.create.mockResolvedValue({
      id: 'eg-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      suppliedById: 'gl-1',
      nominationId: null,
      addedById: 'att-1',
      role: ScheduledGameRole.Primary,
    } as EventGame);

    await service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never);

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(GameAddedToEventEvent.eventName);
    expect(emitted).toBeInstanceOf(GameAddedToEventEvent);
    expect(emitted.action).toBe('create');
    expect(emitted.subjectId).toBe('eg-1');
    expect(emitted.eventId).toBe('event-1');
    expect(emitted.addedByAttendeeId).toBe('att-1');
    expect(emitted.before).toBeNull();
    expect(emitted.after).toEqual({
      id: 'eg-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      suppliedById: 'gl-1',
      nominationId: null,
      addedById: 'att-1',
      role: ScheduledGameRole.Primary,
    });
  });
});

/**
 * A game-list entry as the supplier lock reads it: for pg-1, on the list of an
 * attendee of event-1 who is attending, and neither of them removed.
 */
function lockedSupplier(overrides: Partial<LockedSupplier> = {}): LockedSupplier {
  return {
    eventId: 'event-1',
    platformGameId: 'pg-1',
    status: EventParticipationStatus.Attending,
    attendeeRemovedAt: null,
    entryRemovedAt: null,
    ...overrides,
  };
}

/**
 * The locks a settle takes, in order, as each reads: the supplier's, the
 * event's dates, then the nomination's. The nomination names no date unless
 * one is given.
 */
function mockSettleLocks(
  db: MockDatabaseService,
  supplier: LockedSupplier,
  nomination: { status: NominationStatus; occurrenceId?: string | null },
): void {
  db.$queryRaw
    .mockResolvedValueOnce([supplier] as never)
    .mockResolvedValueOnce([{ id: 'event-1' }] as never)
    .mockResolvedValueOnce([{ occurrenceId: null, ...nomination }] as never);
}

/** A voter as the reads select them: what decides whether their vote counts. */
function voter(status: EventParticipationStatus, removedAt: Date | null = null) {
  return { status, removedAt, availableGames: [] };
}

/** A vote as the nomination include reads it, cast For by `attendee`. */
function voteRow(id: string, attendee: ReturnType<typeof voter>) {
  return { id, attendeeId: `att-${id}`, voteType: VoteType.For, priority: null, comment: null, attendee };
}

/** An open nomination as resolve first reads it, before its lock: on event-1 and no date, supplied from gl-1. */
function openNomination() {
  return {
    id: 'nom-1',
    status: NominationStatus.Open,
    platformGameId: 'pg-1',
    occurrenceId: null,
    suppliedFromId: 'gl-1',
  } as never;
}

/** A nomination row as the include reads it, on event-1 and no date, with no votes unless given. */
function nominationRow(
  overrides: Partial<EventGameNomination> & { votes?: ReturnType<typeof voteRow>[] } = {},
): EventGameNomination {
  return {
    id: 'nom-1',
    eventId: 'event-1',
    occurrenceId: null,
    platformGameId: 'pg-1',
    nominatedById: 'att-1',
    suppliedFromId: 'gl-1',
    status: NominationStatus.Open,
    pausedFrom: null,
    votingDeadline: null,
    votes: [],
    ...overrides,
  } as EventGameNomination;
}
