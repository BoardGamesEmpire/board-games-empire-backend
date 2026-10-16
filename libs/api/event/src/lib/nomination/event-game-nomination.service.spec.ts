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
  // the attendees no host has removed.
  it('resolveNomination counts no vote from a voter who is not attending, out of a pool without removed attendees', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
      platformGameId: 'pg-1',
      occurrenceId: null,
      suppliedFromId: 'gl-1',
      votes: [
        { voteType: VoteType.Against, attendee: voter(EventParticipationStatus.Attending) },
        { voteType: VoteType.For, attendee: voter(EventParticipationStatus.NotAttending) },
        { voteType: VoteType.For, attendee: voter(EventParticipationStatus.NotAttending) },
      ],
    } as never);
    db.eventAttendee.findMany.mockResolvedValue([voter(EventParticipationStatus.Attending)] as never);
    db.$queryRaw
      .mockResolvedValueOnce([lockedSupplier()] as never)
      .mockResolvedValueOnce([{ status: 'Open' }] as never);
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Failed }));

    const { resolution } = await service.resolveNomination('event-1', 'nom-1');

    expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: 'event-1', removedAt: null } }),
    );
    expect(resolution.tally.totalVotes).toBe(1);
    expect(resolution.status).toBe(NominationStatus.Failed);
    expect(db.eventGame.create).not.toHaveBeenCalled();
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
      db.$queryRaw
        .mockResolvedValueOnce([lockedSupplier()] as never)
        .mockResolvedValueOnce([{ status: NominationStatus.AwaitingApproval }] as never);
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
      db.$queryRaw
        .mockResolvedValueOnce([lockedSupplier({ status: EventParticipationStatus.NotAttending })] as never)
        .mockResolvedValueOnce([{ status: NominationStatus.Paused }] as never);

      await expect(service.hostApprove('event-1', 'nom-1')).rejects.toThrow(BadRequestException);
      expect(db.eventGameNomination.update).not.toHaveBeenCalled();
      expect(db.eventGame.create).not.toHaveBeenCalled();
    });

    it('refuses to add the game of a supplier who is not attending to the lineup, and writes nothing', async () => {
      db.$queryRaw
        .mockResolvedValueOnce([lockedSupplier({ status: EventParticipationStatus.NotAttending })] as never)
        .mockResolvedValueOnce([{ status: NominationStatus.AwaitingApproval }] as never);

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
    db.$queryRaw
      .mockResolvedValueOnce([lockedSupplier()] as never)
      .mockResolvedValueOnce([{ status: NominationStatus.AwaitingApproval }] as never);
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

/** A voter as the reads select them: what decides whether their vote counts. */
function voter(status: EventParticipationStatus, removedAt: Date | null = null) {
  return { status, removedAt, availableGames: [] };
}

/** A vote as the nomination include reads it, cast For by `attendee`. */
function voteRow(id: string, attendee: ReturnType<typeof voter>) {
  return { id, attendeeId: `att-${id}`, voteType: VoteType.For, priority: null, comment: null, attendee };
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
