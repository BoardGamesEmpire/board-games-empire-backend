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
  liveEventWhere,
  NominationStatus,
  Prisma,
  ResourceType,
  ScheduledGameRole,
  VoteEligibility,
  VoteQuorumType,
  VoteType,
} from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { MockAbilityService, MockDatabaseService } from '@bge/testing';
import {
  batchTransactionCall,
  createMockAbilityService,
  createMockDatabaseService,
  createTestingModuleWithDb,
  makeVoterRole,
  paginationQuery,
  rawQueryText,
} from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import type { LockedSupplier } from '../attendee/attendance';
import { LINEUP_GAME_SNAPSHOT_SELECT } from '../attendee/attendance';
import { ATTENDEE_SUMMARY_SELECT } from '../attendee/attendee-summary';
import { LINEUP_GAME_SELECT } from '../lineup/lineup-game';
import type { NominateGameDto } from './dto/nominate-game.dto';
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
    // The event is live under each write's lock (#1065).
    db.event.count.mockResolvedValue(1);
    // The attendee read that names a lineup game's supplier, and a
    // nomination's nominator and supplier; a test that asserts on one mocks
    // its own answer.
    db.eventAttendee.findMany.mockResolvedValue([]);
    // The read of the lineup game each nomination became, and of the dates it
    // reads them through; none unless a test says otherwise.
    db.eventGame.findMany.mockResolvedValue([]);
    db.eventOccurrence.findMany.mockResolvedValue([]);

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

    // #512. The `EventGameNomination` envelope fails with a 500 unless this
    // read composes. The rows do not
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

    it('marks the vote of a voter whose event role does not hold the vote as not counting (#759)', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        nominationRow({ votes: [voteRow('vote-spectator', voter(EventParticipationStatus.Attending, null, false))] }),
      );

      const nomination = await service.getNomination('event-1', 'nom-1');

      expect(nomination.votes).toEqual([expect.objectContaining({ id: 'vote-spectator', eligible: false })]);
    });
  });

  // In the nomination's include, an attendee's name and avatar would reach an
  // actor holding read on nominations alone (#559): who made each nomination
  // and whose offered game supplies it are read once for the page, under the
  // attendee read ceiling.
  describe('who made each nomination, and whose offered game supplies it (#1213)', () => {
    beforeEach(() => db.event.count.mockResolvedValue(1));

    it('names the nominator and the supplier from one attendee read under its ceiling (#1213)', async () => {
      db.eventGameNomination.findMany.mockResolvedValue([
        nominationRow({ id: 'nom-1', nominatedById: 'att-1', suppliedFrom: { id: 'gl-1', attendeeId: 'att-2' } }),
        nominationRow({ id: 'nom-2', nominatedById: 'att-2', suppliedFrom: { id: 'gl-3', attendeeId: 'att-3' } }),
      ]);
      db.eventGameNomination.count.mockResolvedValue(2);
      db.eventAttendee.findMany.mockResolvedValue([attendee('att-1'), attendee('att-2'), attendee('att-3')] as never);

      const { rows } = await service.getNominations('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventAttendee.findMany).toHaveBeenCalledTimes(1);
      expect(db.eventAttendee.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['att-1', 'att-2', 'att-3'] }, AND: [COND] },
        select: ATTENDEE_SUMMARY_SELECT,
      });
      expect(rows.map(({ id, nominatedBy, suppliedFrom }) => [id, nominatedBy, suppliedFrom])).toEqual([
        ['nom-1', attendee('att-1'), { id: 'gl-1', attendeeId: 'att-2', attendee: attendee('att-2') }],
        ['nom-2', attendee('att-2'), { id: 'gl-3', attendeeId: 'att-3', attendee: attendee('att-3') }],
      ]);
    });

    // Such as an API key holding read on nominations alone. The ids stay, so
    // the actor still tells two nominations by one attendee from two by two.
    it("serves nominatedBy and suppliedFrom.attendee null, ids kept, for an actor who can't read attendees (#1213)", async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(nominationRow());
      db.eventAttendee.findMany.mockResolvedValue([]);

      const nomination = await service.getNomination('event-1', 'nom-1');

      expect(nomination.nominatedById).toBe('att-1');
      expect(nomination.nominatedBy).toBeNull();
      expect(nomination.suppliedFrom).toEqual({ id: 'gl-1', attendeeId: 'att-2', attendee: null });
    });
  });

  // The read itself, under the lineup and date read ceilings, is
  // `readableLineupGamesByNomination`'s, and its spec covers it.
  describe('the lineup game each nomination became (#799)', () => {
    beforeEach(() => {
      db.event.count.mockResolvedValue(1);
      db.eventGameNomination.count.mockResolvedValue(3);
      db.eventOccurrencePolicy.findMany.mockResolvedValue([]);
    });

    // A lineup game is on its nomination's date, so only the dates the page's
    // nominations name are read, each once. Only a nomination whose outcome
    // added its game can have one, so the others aren't read for.
    it("serves each nomination's lineup game as elevatedTo, read for the page's nominations and their dates (#799)", async () => {
      db.eventGameNomination.findMany.mockResolvedValue([
        nominationRow({ id: 'nom-1', occurrenceId: 'occ-1', status: NominationStatus.Passed }),
        nominationRow({ id: 'nom-2', occurrenceId: 'occ-1' }),
        nominationRow({ id: 'nom-3' }),
      ]);
      db.eventOccurrence.findMany.mockResolvedValue([{ id: 'occ-1' }] as never);
      db.eventGame.findMany.mockResolvedValue([{ id: 'eg-1', occurrenceId: 'occ-1', nominationId: 'nom-1' }] as never);

      const { rows } = await service.getNominations('event-1', paginationQuery({ limit: 10 }));

      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith({
        where: { eventId: 'event-1', id: { in: ['occ-1'] }, AND: [COND] },
        select: { id: true },
      });
      expect(db.eventGame.findMany).toHaveBeenCalledWith({
        where: {
          nominationId: { in: ['nom-1'] },
          OR: [{ eventId: 'event-1' }, { occurrenceId: { in: ['occ-1'] } }],
          AND: [COND],
        },
        select: { id: true, occurrenceId: true, nominationId: true },
      });
      expect(rows.map(({ id, elevatedTo }) => [id, elevatedTo])).toEqual([
        ['nom-1', { id: 'eg-1', occurrenceId: 'occ-1' }],
        ['nom-2', null],
        ['nom-3', null],
      ]);
    });

    // An open, withdrawn or rejected nomination has no lineup game, so a page
    // of them reads neither the dates nor the lineup for one (#799).
    it.each([NominationStatus.Open, NominationStatus.Withdrawn, NominationStatus.Rejected])(
      'reads no lineup game for a page of %s nominations (#799)',
      async (status) => {
        db.eventGameNomination.findMany.mockResolvedValue([
          nominationRow({ id: 'nom-1', occurrenceId: 'occ-1', status }),
        ]);

        const { rows } = await service.getNominations('event-1', paginationQuery({ limit: 10 }));

        expect(db.eventOccurrence.findMany).not.toHaveBeenCalled();
        expect(db.eventGame.findMany).not.toHaveBeenCalled();
        expect(rows[0].elevatedTo).toBeNull();
      },
    );
  });

  // #759: whether a voter counts follows their event role's grant of the game
  // vote as it is now, whichever role holds it and whoever added the edge. A
  // retired permission confers nothing, nor does one an operator inverted into
  // a denial.
  it("resolveNomination reads each voter's role grant for the game vote, live, unretired and not a denial", async () => {
    db.eventGameNomination.findUnique.mockResolvedValue(openNomination());
    db.eventGameVote.findMany.mockResolvedValue([{ voteType: VoteType.For, attendeeId: 'att-in' }] as never);
    db.eventAttendee.findMany.mockResolvedValue([
      { id: 'att-in', ...voter(EventParticipationStatus.Attending) },
    ] as never);
    mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.Open });
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Passed }));
    db.eventGame.create.mockResolvedValue({ id: 'eg-1', nominationId: 'nom-1' } as EventGame);

    await service.resolveNomination('event-1', 'nom-1');

    expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          userId: true,
          role: {
            select: {
              role: {
                select: {
                  permissions: {
                    where: {
                      revokedAt: null,
                      permission: { is: { slug: 'create:event_game_vote', retiredAt: null, inverted: false } },
                    },
                    select: { id: true },
                    take: 1,
                  },
                },
              },
            },
          },
        }),
      }),
    );
  });

  // Under the vote eligibility of only those offering games, an offer counts
  // only while it is live: not taken back, and its collection entry not
  // removed. A voter whose only offered game was removed from their
  // collection offers nothing until it is added back, so their vote stops
  // counting (#1221).
  it("resolveNomination reads each voter's offered games as live offers only, to count who offers games (#1221)", async () => {
    db.eventGameNomination.findUnique.mockResolvedValue(openNomination());
    db.eventGameVote.findMany.mockResolvedValue([{ voteType: VoteType.For, attendeeId: 'att-in' }] as never);
    db.eventAttendee.findMany.mockResolvedValue([
      { id: 'att-in', ...voter(EventParticipationStatus.Attending) },
    ] as never);
    mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.Open });
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Passed }));
    db.eventGame.create.mockResolvedValue({ id: 'eg-1', nominationId: 'nom-1' } as EventGame);

    await service.resolveNomination('event-1', 'nom-1');

    expect(db.eventAttendee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          availableGames: {
            where: { removedAt: null, collection: { is: { deletedAt: null } } },
            select: { id: true },
            take: 1,
          },
        }),
      }),
    );
  });

  // Each vote a read serves is marked by the same rule (#1221).
  it("getNomination reads each voter's offered games as live offers only, to mark their vote (#1221)", async () => {
    db.eventGameNomination.findUnique.mockResolvedValue(nominationRow({ votes: [] }));

    await service.getNomination('event-1', 'nom-1');

    expect(db.eventGameNomination.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          votes: {
            select: expect.objectContaining({
              attendee: {
                select: expect.objectContaining({
                  availableGames: {
                    where: { removedAt: null, collection: { is: { deletedAt: null } } },
                    select: { id: true },
                    take: 1,
                  },
                }),
              },
            }),
          },
        }),
      }),
    );
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

  // #798: the outcome was read off the threshold alone, so a nomination short
  // of quorum whose few votes met the threshold passed, and its game entered
  // the lineup. The resolver's own status is stored and returned as it is.
  it('resolveNomination stores QuorumNotMet when quorum fails though the threshold is met, and adds nothing to the lineup (#798)', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      voteQuorumType: VoteQuorumType.PercentOfAttendees,
      voteQuorumValue: 50,
    } as EventPolicy);
    db.eventGameNomination.findUnique.mockResolvedValue(openNomination());
    db.eventGameVote.findMany.mockResolvedValue([{ voteType: VoteType.For, attendeeId: 'att-1' }] as never);
    db.eventAttendee.findMany.mockResolvedValue(
      ['att-1', 'att-2', 'att-3', 'att-4'].map((id) => ({ id, ...voter(EventParticipationStatus.Attending) })) as never,
    );
    mockSettleLocks(db, lockedSupplier(), { status: NominationStatus.Open });
    db.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.QuorumNotMet }));
    // Answered, so a resolve that wrongly adds the game fails on the assertions below.
    db.eventGame.create.mockResolvedValue({ id: 'eg-1', nominationId: 'nom-1' } as EventGame);

    const { resolution } = await service.resolveNomination('event-1', 'nom-1');

    expect(db.eventGameNomination.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: NominationStatus.QuorumNotMet } }),
    );
    expect(resolution.status).toBe(NominationStatus.QuorumNotMet);
    expect(resolution.quorumMet).toBe(false);
    expect(resolution.thresholdMet).toBe(true);
    expect(db.eventGame.create).not.toHaveBeenCalled();
  });

  // The status is first checked outside the transaction; the supplier leaving
  // in between pauses the nomination, so it is checked again under its lock,
  // before anything is counted.
  it('resolveNomination answers 400 for a nomination that paused after it was read, and counts and writes nothing', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue(openNomination());
    mockSettleLocks(db, lockedSupplier({ status: EventParticipationStatus.NotAttending }), {
      status: NominationStatus.Paused,
    });

    // The status the lock found, not the one first read (#1114).
    expect(await refusalOf(service.resolveNomination('event-1', 'nom-1'))).toEqual(
      codedRefusal(Http.BadRequest, 'NOMINATION_NOT_RESOLVABLE', { state: NominationStatus.Paused }),
    );
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

    // A row deleted since the first read has no status to put in a sentence:
    // the one expected would misstate it, so it answers as missing (#1114).
    it.each(settles)(
      '$caller answers 404 when the nomination is gone under the lock (#1114)',
      async ({ status, settle }) => {
        arrange(status, 'occ-1');
        db.$queryRaw.mockReset();
        mockSettleLocks(db, lockedSupplier(), null);

        const attempt = settle();

        await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
        await expect(attempt).rejects.toThrow(
          new NotFoundException(t('errors.nomination.not_found', { nominationId: 'nom-1', eventId: 'event-1' })),
        );
        expect(db.eventGameVote.findMany).not.toHaveBeenCalled();
        expect(db.eventGameNomination.update).not.toHaveBeenCalled();
        expect(db.eventGame.create).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      },
    );

    // A lost race is an expected answer, as in withdraw: logged no more than
    // the same refusal from the first read, which is not logged at all (#1114).
    it.each(
      settles.flatMap((entry) => [
        { ...entry, answer: '400 for a nomination settled first', locked: NominationStatus.Withdrawn },
        { ...entry, answer: '404 for a nomination gone', locked: null },
      ]),
    )('$caller logs no error when it answers $answer at the lock', async ({ status, settle, locked }) => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      arrange(status, 'occ-1');
      db.$queryRaw.mockReset();
      mockSettleLocks(db, lockedSupplier(), locked === null ? null : { status: locked, occurrenceId: 'occ-1' });

      await expect(settle()).rejects.toThrow();
      expect(logged).not.toHaveBeenCalled();

      logged.mockRestore();
    });

    // The answer is read in the settle's transaction. Read after the commit, a
    // failed read would answer an error for an outcome that was settled, and
    // the retry would answer 400 for a nomination no longer awaiting one (#799).
    it.each(settles)('$caller emits nothing when its answer fails to read (#799)', async ({ status, settle }) => {
      arrange(status, 'occ-1');
      db.eventGame.findMany.mockRejectedValue(new Error('connection lost'));

      await expect(settle()).rejects.toThrow('connection lost');
      expect(emitter.emit).not.toHaveBeenCalled();
    });

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

  /**
   * #621. A withdraw locks the nomination's row and reads its status again,
   * so one that loses a race to a settle answers 400, as a request arriving
   * after the settle would, rather than writing Withdrawn over the outcome.
   */
  describe('withdraw under the nomination row lock (#621)', () => {
    /** The transaction's client, apart from `db`, so a lock or a write outside the transaction can't pass for one inside it. */
    let tx: MockDatabaseService;

    beforeEach(() => {
      tx = createMockDatabaseService();
      db.$transaction.mockImplementation((async (callback: (client: MockDatabaseService) => Promise<unknown>) => {
        const result = await callback(tx);

        // Nothing is told of a change before it commits.
        expect(emitter.emit).not.toHaveBeenCalled();

        return result;
      }) as never);

      tx.eventGameNomination.update.mockResolvedValue(nominationRow({ status: NominationStatus.Withdrawn }));
      tx.eventAttendee.findMany.mockResolvedValue([]);
      tx.event.count.mockResolvedValue(1);
    });

    // Read after the commit, a failed read would answer 500 for a withdraw
    // that happened (#799).
    it('reads its answer in the transaction, before the commit (#799)', async () => {
      arrangeWithdraw(NominationStatus.Open);

      await service.withdraw('event-1', 'nom-1');

      expect(tx.eventAttendee.findMany).toHaveBeenCalled();
      expect(tx.eventPolicy.findUnique).toHaveBeenCalled();
      expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
      expect(db.eventPolicy.findUnique).not.toHaveBeenCalled();
    });

    /**
     * The nomination as the first read finds it, and the status the read
     * under the lock finds: the same unless a test says otherwise, and no
     * row at all for `null`.
     */
    const arrangeWithdraw = (
      first: NominationStatus,
      { locked = first, nominatedById = 'att-1' }: { locked?: NominationStatus | null; nominatedById?: string } = {},
    ) => {
      db.eventGameNomination.findUnique.mockResolvedValue({
        id: 'nom-1',
        nominatedById,
        status: first,
      } as EventGameNomination);
      tx.$queryRaw.mockResolvedValue(locked === null ? [] : [{ status: locked }]);
    };

    const dependentRecordNotFound = () =>
      new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
        code: 'P2025',
        clientVersion: 'test',
      });

    it('locks the nomination FOR NO KEY UPDATE before writing', async () => {
      arrangeWithdraw(NominationStatus.Open);

      await service.withdraw('event-1', 'nom-1');

      // After the event's row, which comes first (#1065).
      const [[eventLock], [lock]] = tx.$queryRaw.mock.calls;
      expect(rawQueryText(eventLock)).toMatch(/^SELECT id FROM events WHERE id = \? FOR SHARE$/);
      expect(rawQueryText(lock)).toMatch(/^SELECT status FROM event_game_nominations WHERE id = \? FOR NO KEY UPDATE$/);
      expect((lock as Prisma.Sql).values).toEqual(['nom-1']);
      expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        tx.eventGameNomination.update.mock.invocationCallOrder[0],
      );
    });

    // The refusal names the status the lock found, not the one first read (#1114).
    it('answers 400 for a nomination settled since the first read, and writes nothing', async () => {
      arrangeWithdraw(NominationStatus.Open, { locked: NominationStatus.Approved });

      expect(await refusalOf(service.withdraw('event-1', 'nom-1'))).toEqual(
        codedRefusal(Http.BadRequest, 'NOMINATION_NOT_WITHDRAWABLE', { state: NominationStatus.Approved }),
      );
      expect(tx.eventGameNomination.update).not.toHaveBeenCalled();
      expect(db.eventGameNomination.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // A lost race is an expected answer: logged no more than the same refusal
    // from the first read, which is not logged at all.
    it.each([
      ['400 for a settled nomination', NominationStatus.Approved],
      ['404 for a nomination gone', null],
    ])('logs no error when it answers %s at the lock', async (_case, locked) => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      arrangeWithdraw(NominationStatus.Open, { locked });

      await expect(service.withdraw('event-1', 'nom-1')).rejects.toThrow();
      expect(logged).not.toHaveBeenCalled();

      logged.mockRestore();
    });

    it('answers 404 for a nomination gone at the lock', async () => {
      arrangeWithdraw(NominationStatus.Open, { locked: null });

      await expect(service.withdraw('event-1', 'nom-1')).rejects.toThrow(
        new NotFoundException(t('errors.nomination.not_found', { nominationId: 'nom-1', eventId: 'event-1' })),
      );
      expect(tx.eventGameNomination.update).not.toHaveBeenCalled();
    });

    // The write repeats the status the read under the lock found, so a write
    // that finds no row was refused by the ceiling alone.
    it('requires the status read under the lock in the write', async () => {
      arrangeWithdraw(NominationStatus.Open);

      await service.withdraw('event-1', 'nom-1');

      expect(tx.eventGameNomination.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'nom-1', status: NominationStatus.Open, AND: [COND] } }),
      );
    });

    // A supplier leaving the event pauses the nomination in the leaving
    // transaction (#551). It is still the nominator's to withdraw, and the
    // domain event names the status the write replaced.
    it('withdraws a nomination paused since the first read, naming Paused as the before-status', async () => {
      arrangeWithdraw(NominationStatus.Open, { locked: NominationStatus.Paused });

      await service.withdraw('event-1', 'nom-1');

      expect(tx.eventGameNomination.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: NominationStatus.Paused }),
          data: { status: NominationStatus.Withdrawn, pausedFrom: null },
        }),
      );
      const [, emitted] = emitter.emit.mock.calls.find(([name]) => name === NominationWithdrawnEvent.eventName) ?? [];
      expect(emitted?.before).toEqual({ id: 'nom-1', eventId: 'event-1', status: NominationStatus.Paused });
    });

    it('still answers 403 when the ceiling refuses the nomination', async () => {
      arrangeWithdraw(NominationStatus.Open);
      tx.eventGameNomination.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.withdraw('event-1', 'nom-1')).rejects.toThrow(
        new ForbiddenException(t('errors.nomination.forbidden_withdraw')),
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('withdraw → update', async () => {
      arrangeWithdraw(NominationStatus.Open);

      await service.withdraw('event-1', 'nom-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventGameNomination,
        Action.update,
      );
      expect(tx.eventGameNomination.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'nom-1', AND: [COND] }) }),
      );
    });

    it('withdraw emits a NominationWithdrawnEvent carrying the status transition', async () => {
      arrangeWithdraw(NominationStatus.Open);

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
      arrangeWithdraw(NominationStatus.Paused);

      await service.withdraw('event-1', 'nom-1');

      expect(tx.eventGameNomination.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: NominationStatus.Withdrawn, pausedFrom: null } }),
      );
    });

    // Refused by the first read, so it takes no lock.
    it('withdraw forbids a non-nominator', async () => {
      arrangeWithdraw(NominationStatus.Open, { nominatedById: 'someone-else' });

      await expect(service.withdraw('event-1', 'nom-1')).rejects.toThrow(ForbiddenException);
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('answers 400 for a status the first read already refuses, without locking', async () => {
      arrangeWithdraw(NominationStatus.Approved);

      expect(await refusalOf(service.withdraw('event-1', 'nom-1'))).toEqual(
        codedRefusal(Http.BadRequest, 'NOMINATION_NOT_WITHDRAWABLE', { state: NominationStatus.Approved }),
      );
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });
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

      expect(await refusalOf(service.hostApprove('event-1', 'nom-1'))).toEqual(
        codedRefusal(Http.BadRequest, 'NOMINATION_NOT_AWAITING_APPROVAL', { state: NominationStatus.Paused }),
      );
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

  // A nomination resolved short of quorum is final, like one that failed:
  // nominating the game again starts a new vote (#798).
  it.each([NominationStatus.Passed, NominationStatus.Failed, NominationStatus.QuorumNotMet])(
    'resolveNomination rejects a %s nomination',
    async (status) => {
      db.eventGameNomination.findUnique.mockResolvedValue({
        id: 'nom-1',
        eventId: 'event-1',
        status,
        platformGameId: 'pg-1',
        occurrenceId: null,
        releaseId: null,
        votingDeadline: null,
        nominatedById: 'att-1',
        suppliedFromId: 'gl-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as EventGameNomination);

      expect(await refusalOf(service.resolveNomination('event-1', 'nom-1'))).toEqual(
        codedRefusal(Http.BadRequest, 'NOMINATION_NOT_RESOLVABLE', { state: status }),
      );
    },
  );

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

    // The status the lock found, not the one first read (#1114).
    expect(await refusalOf(service.castVote('event-1', 'nom-1', { voteType: VoteType.For }))).toEqual(
      codedRefusal(Http.BadRequest, 'NOMINATION_NOT_OPEN', { state: NominationStatus.Paused }),
    );
    expect(db.eventGameVote.upsert).not.toHaveBeenCalled();
  });

  // A row deleted since the first check has no status to put in a sentence:
  // the one first read would misstate it, so it answers as missing (#1114).
  it('castVote answers 404 when the nomination is gone under the lock (#1114)', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.$queryRaw.mockResolvedValue([] as never);

    const attempt = service.castVote('event-1', 'nom-1', { voteType: VoteType.For });

    await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
    await expect(attempt).rejects.toThrow(
      new NotFoundException(t('errors.nomination.not_found', { nominationId: 'nom-1', eventId: 'event-1' })),
    );
    expect(db.eventGameVote.upsert).not.toHaveBeenCalled();
  });

  it('castVote refuses a nomination that is not open at the first check, without locking (#1114)', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Withdrawn,
    } as EventGameNomination);

    expect(await refusalOf(service.castVote('event-1', 'nom-1', { voteType: VoteType.For }))).toEqual(
      codedRefusal(Http.BadRequest, 'NOMINATION_NOT_OPEN', { state: NominationStatus.Withdrawn }),
    );
    expect(db.$transaction).not.toHaveBeenCalled();
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

  // The write is checked against the row it creates, not filtered. The
  // answer's reads, after the commit, compose under their own ceilings: who
  // made it and who supplies it (#1213), and the lineup game it became (#799).
  it("nominate fetches no ability condition before it writes; only its answer's reads compose (#1213)", async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: 'RequiresVote',
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);

    db.eventGameNomination.create.mockResolvedValue(nominationRow());

    await service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto);

    const [written] = db.eventGameNomination.create.mock.invocationCallOrder;
    const fetchedBefore = abilityService.getCurrentResourceConditions.mock.invocationCallOrder.filter(
      (order) => order < written,
    );
    expect(written).toBeDefined();
    expect(fetchedBefore).toEqual([]);
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

  // A game removed from its owner's collection is supplied by nobody, though
  // its offer stays in place. A supply check answers as it does for an offer
  // taken back, and holds the collection entry's row with the offer and the
  // attendee, so a removal and the write take turns (#1221).
  describe("a supply check, on an entry removed from its owner's collection (#1221)", () => {
    const supplierNotFound = t('errors.nomination.supplier_not_found', { gameListId: 'gl-1' });

    const supplyChecks = [
      {
        write: 'nominate',
        arrange: () => {
          db.eventPolicy.findUnique.mockResolvedValue({
            gameAdditionMode: 'RequiresVote',
            votingWindowHours: null,
          } as EventPolicy);
          db.$queryRaw.mockResolvedValueOnce([lockedSupplier({ collectionRemovedAt: new Date() })] as never);
        },
        run: () => service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto),
        written: () => db.eventGameNomination.create,
      },
      {
        write: 'directAddGame',
        arrange: () => {
          db.eventPolicy.findUnique.mockResolvedValue({
            gameAdditionMode: GameAdditionMode.Direct,
            votingWindowHours: null,
          } as EventPolicy);
          db.$queryRaw.mockResolvedValueOnce([lockedSupplier({ collectionRemovedAt: new Date() })] as never);
        },
        run: () => service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never),
        written: () => db.eventGame.create,
      },
      {
        write: 'hostApprove',
        arrange: () => {
          db.eventGameNomination.findUnique.mockResolvedValue({
            id: 'nom-1',
            status: NominationStatus.AwaitingApproval,
            platformGameId: 'pg-1',
            occurrenceId: null,
            suppliedFromId: 'gl-1',
          } as EventGameNomination);
          mockSettleLocks(db, lockedSupplier({ collectionRemovedAt: new Date() }), {
            status: NominationStatus.AwaitingApproval,
          });
        },
        run: () => service.hostApprove('event-1', 'nom-1'),
        written: () => db.eventGame.create,
      },
    ];

    it.each(supplyChecks)(
      'assertSupplies answers 404 supplier_not_found for an entry removed from its collection, on $write (#1221)',
      async ({ arrange, run, written }) => {
        arrange();

        const rejection = await run().catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(NotFoundException);
        expect((rejection as NotFoundException).getResponse()).toEqual(supplierNotFound);
        expect(written()).not.toHaveBeenCalled();
      },
    );

    it("lockSupplier reads the collection entry's removal and holds its row with the offer and the attendee (#1221)", async () => {
      supplyChecks[0].arrange();

      await expect(supplyChecks[0].run()).rejects.toThrow(NotFoundException);

      const [[supplierLock]] = db.$queryRaw.mock.calls;
      expect(rawQueryText(supplierLock)).toMatch(/c\.deleted_at AS "collectionRemovedAt"/);
      expect(rawQueryText(supplierLock)).toMatch(/FOR SHARE OF l, a, c$/);
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
    db.eventGame.create.mockResolvedValue({
      id: 'eg-1',
      eventId: 'event-1',
      suppliedBy: { id: 'gl-1', attendeeId: 'att-2' },
    } as never);

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
    db.eventGame.create.mockResolvedValue({
      id: 'eg-1',
      occurrenceId: 'occ-1',
      suppliedBy: { id: 'gl-1', attendeeId: 'att-2' },
    } as never);

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

  // The mode stays a field; the message says to nominate instead (#1114).
  it('directAddGame refuses under RequiresVote with 403 GAME_ADDITION_NOT_DIRECT, and writes nothing (#1114)', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.RequiresVote,
      votingWindowHours: null,
    } as EventPolicy);

    expect(
      await refusalOf(service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never)),
    ).toEqual(codedRefusal(Http.Forbidden, 'GAME_ADDITION_NOT_DIRECT', { mode: GameAdditionMode.RequiresVote }));
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

  // The lineup game is read in the transaction that added it, after the add,
  // so the answer finds it. Read after the commit instead, a failed read
  // would answer 500 for a nomination that was made, and a retry would make
  // it, and add its game, twice.
  describe('a Direct-mode nomination reads its answer before the commit (#799)', () => {
    let tx: MockDatabaseService;

    beforeEach(() => {
      tx = createMockDatabaseService();
      db.$transaction.mockImplementation(((callback: (client: MockDatabaseService) => Promise<unknown>) =>
        callback(tx)) as never);
      db.eventPolicy.findUnique.mockResolvedValue({
        gameAdditionMode: GameAdditionMode.Direct,
        votingWindowHours: null,
      } as EventPolicy);
      tx.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
      tx.eventGameNomination.create.mockResolvedValue(nominationRow({ status: NominationStatus.Passed }));
      tx.eventGame.create.mockResolvedValue({ id: 'eg-1', nominationId: 'nom-1' } as EventGame);
      tx.eventAttendee.findMany.mockResolvedValue([]);
      tx.event.count.mockResolvedValue(1);
    });

    it('answers with elevatedTo set when its game joined the lineup (#799)', async () => {
      tx.eventGame.findMany.mockResolvedValue([{ id: 'eg-1', occurrenceId: null, nominationId: 'nom-1' }] as never);

      const answer = await service.nominate('event-1', {
        platformGameId: 'pg-1',
        suppliedFromId: 'gl-1',
      } as NominateGameDto);

      expect(answer.elevatedTo).toEqual({ id: 'eg-1', occurrenceId: null });
      expect(db.eventGame.findMany).not.toHaveBeenCalled();
      expect(tx.eventGame.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(
        tx.eventGame.create.mock.invocationCallOrder[0],
      );
    });

    it('emits nothing when the read fails (#799)', async () => {
      tx.eventGame.findMany.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto),
      ).rejects.toThrow('connection lost');
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  // The direct add answers the one lineup-game shape the lineup and date reads
  // serve, so a client renders an added game as it renders a read one (#799).
  it('answers the added game in the lineup shape, its supplier named (#799)', async () => {
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
      sortOrder: 0,
      notes: null,
      maxPlayTime: null,
      platformGame: { id: 'pg-1' },
      suppliedBy: { id: 'gl-1', attendeeId: 'att-2' },
    } as never);
    const supplier = { id: 'att-2', status: EventParticipationStatus.Attending, guestName: null, user: null };
    db.eventAttendee.findMany.mockResolvedValue([supplier] as never);

    const answer = await service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never);

    expect(db.eventGame.create).toHaveBeenCalledWith(
      expect.objectContaining({ select: { ...LINEUP_GAME_SNAPSHOT_SELECT, ...LINEUP_GAME_SELECT } }),
    );
    expect(answer).toEqual({
      id: 'eg-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      nominationId: null,
      addedById: 'att-1',
      role: ScheduledGameRole.Primary,
      sortOrder: 0,
      notes: null,
      maxPlayTime: null,
      platformGame: { id: 'pg-1' },
      suppliedBy: { id: 'gl-1', attendeeId: 'att-2', attendee: supplier },
    });
    expect(answer).not.toHaveProperty('eventId');
    expect(answer).not.toHaveProperty('suppliedById');

    const [, emitted] = emitter.emit.mock.calls[0];
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

  it('answers a supplier the actor cannot read as attendee null (#799)', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGame.create.mockResolvedValue({
      id: 'eg-1',
      suppliedById: 'gl-1',
      suppliedBy: { id: 'gl-1', attendeeId: 'att-2' },
    } as never);
    db.eventAttendee.findMany.mockResolvedValue([] as never);

    const answer = await service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never);

    expect(answer.suppliedBy).toEqual({ id: 'gl-1', attendeeId: 'att-2', attendee: null });
  });

  // A read after the commit that failed would answer 500 for an add that
  // happened, and the retry would add the game twice (#799).
  it("reads the supplier's attendee before the commit: a failed read emits nothing (#799)", async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.$queryRaw.mockResolvedValueOnce([lockedSupplier()] as never);
    db.eventGame.create.mockResolvedValue({
      id: 'eg-1',
      suppliedById: 'gl-1',
      suppliedBy: { id: 'gl-1', attendeeId: 'att-2' },
    } as never);
    db.eventAttendee.findMany.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never),
    ).rejects.toThrow('connection lost');
    expect(emitter.emit).not.toHaveBeenCalled();
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
      suppliedBy: { id: 'gl-1', attendeeId: 'att-2' },
    } as never);

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

  // Each answers the 404 the event's read gives, and writes nothing. The
  // check runs under the event's row lock, so a delete that commits after the
  // first read can't slip between the check and the write (#1065).
  describe('a write on a deleted event, or one whose household is deleted (#1065)', () => {
    const isEventShare = (query: unknown) =>
      /^SELECT id FROM events WHERE id = \? FOR SHARE$/.test(rawQueryText(query));

    beforeEach(() => {
      db.event.count.mockResolvedValue(0);
      db.eventPolicy.findUnique.mockResolvedValue({
        gameAdditionMode: GameAdditionMode.Direct,
        votingWindowHours: null,
      } as EventPolicy);
    });

    /**
     * A nomination by the actor in `status`, and each raw read finding its
     * row: the supplier for the supply checks, the nomination for the rest.
     */
    const arrangeNomination = (status: NominationStatus) => {
      db.eventGameNomination.findUnique.mockResolvedValue(nominationRow({ status }));
      db.$queryRaw.mockImplementation(((query: unknown) =>
        Promise.resolve(
          /FROM attendee_game_lists/.test(rawQueryText(query)) ? [lockedSupplier()] : [{ status, occurrenceId: null }],
        )) as never);
    };

    const writes = [
      {
        name: 'nominate',
        supplies: true,
        status: NominationStatus.Open,
        run: () => service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto),
      },
      {
        name: 'directAddGame',
        supplies: true,
        status: NominationStatus.Open,
        run: () => service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never),
      },
      {
        name: 'withdraw',
        supplies: false,
        status: NominationStatus.Open,
        run: () => service.withdraw('event-1', 'nom-1'),
      },
      {
        name: 'castVote',
        supplies: false,
        status: NominationStatus.Open,
        run: () => service.castVote('event-1', 'nom-1', { voteType: VoteType.For }),
      },
      {
        name: 'resolveNomination',
        supplies: true,
        status: NominationStatus.Open,
        run: () => service.resolveNomination('event-1', 'nom-1'),
      },
      {
        name: 'hostApprove',
        supplies: true,
        status: NominationStatus.AwaitingApproval,
        run: () => service.hostApprove('event-1', 'nom-1'),
      },
      {
        name: 'hostReject',
        supplies: true,
        status: NominationStatus.AwaitingApproval,
        run: () => service.hostReject('event-1', 'nom-1'),
      },
    ];

    it.each(writes)("$name refuses a deleted event under the event's row lock (#1065)", async ({ status, run }) => {
      arrangeNomination(status);

      await expect(run()).rejects.toBeInstanceOf(NotFoundException);

      const share = db.$queryRaw.mock.calls.findIndex(([query]) => isEventShare(query));
      expect(share).toBeGreaterThanOrEqual(0);
      expect(db.$queryRaw.mock.invocationCallOrder[share]).toBeLessThan(db.event.count.mock.invocationCallOrder[0]);
      expect(db.event.count).toHaveBeenCalledWith({ where: { id: 'event-1', ...liveEventWhere() } });
      expect(db.eventGameNomination.create).not.toHaveBeenCalled();
      expect(db.eventGameNomination.update).not.toHaveBeenCalled();
      expect(db.eventGame.create).not.toHaveBeenCalled();
      expect(db.eventGameVote.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // A supply check locks the supplier's rows before the event's, the order
    // a supplier leaving takes them in; the rest lock the event's row before
    // anything else (#1065).
    it.each(writes)("$name takes the event's row lock in its place (#1065)", async ({ supplies, status, run }) => {
      arrangeNomination(status);

      await run().catch(() => undefined);

      expect(db.$queryRaw.mock.calls.findIndex(([query]) => isEventShare(query))).toBe(supplies ? 1 : 0);
    });

    // The supplier's answer is judged only once the event's is: a supplier
    // who left as the event was deleted still gets the deleted event's 404,
    // not a 409 for the supplier (#1065).
    it.each(writes.filter(({ name }) => name === 'nominate' || name === 'directAddGame'))(
      "$name answers the event's 404 before judging a supplier who also left (#1065)",
      async ({ status, run }) => {
        arrangeNomination(status);
        db.$queryRaw.mockImplementation(((query: unknown) =>
          Promise.resolve(
            /FROM attendee_game_lists/.test(rawQueryText(query))
              ? [lockedSupplier({ status: EventParticipationStatus.NotAttending })]
              : [],
          )) as never);

        const rejection: unknown = await run().catch((e: unknown) => e);

        expect(rejection).toBeInstanceOf(NotFoundException);
        expect((rejection as NotFoundException).getResponse()).toEqual(t('errors.event.not_found', { id: 'event-1' }));
      },
    );
  });
});

/**
 * A game-list entry as the supplier lock reads it: for pg-1, on the list of an
 * attendee of event-1 who is attending, and none of the entry, its collection
 * entry or the attendee removed.
 */
function lockedSupplier(overrides: Partial<LockedSupplier> = {}): LockedSupplier {
  return {
    eventId: 'event-1',
    platformGameId: 'pg-1',
    status: EventParticipationStatus.Attending,
    attendeeRemovedAt: null,
    collectionRemovedAt: null,
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
  nomination: { occurrenceId?: string | null; status: NominationStatus } | null,
): void {
  db.$queryRaw
    .mockResolvedValueOnce([supplier] as never)
    .mockResolvedValueOnce([{ id: 'event-1' }] as never)
    .mockResolvedValueOnce((nomination ? [{ occurrenceId: null, ...nomination }] : []) as never);
}

/** The HTTP status and body a promise is refused with; it fails the test unless that is a coded refusal. */
async function refusalOf(attempt: Promise<unknown>): Promise<{ body: unknown; httpStatus: number }> {
  const error = await attempt.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CodedHttpException);
  const refusal = error as CodedHttpException;

  return { httpStatus: refusal.getStatus(), body: refusal.getResponse() };
}

/** A coded refusal as {@link refusalOf} reads it: its status, its code and the fields beside them. */
function codedRefusal(httpStatus: number, code: string, fields: Record<string, unknown>) {
  return { httpStatus, body: expect.objectContaining({ code, ...fields }) };
}

/**
 * A voter as the reads select them: what decides whether their vote counts.
 * They have an account, and their event role holds the game vote unless
 * `grant` is false.
 */
function voter(status: EventParticipationStatus, removedAt: Date | null = null, grant = true) {
  return {
    userId: 'user-x',
    role: makeVoterRole(grant),
    status,
    removedAt,
    availableGames: [],
  };
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

/**
 * A nomination row as the include reads it, on event-1 and no date, made by
 * att-1 of a game from att-2's offered games, with no votes unless given.
 */
function nominationRow(
  overrides: Partial<EventGameNomination> & {
    suppliedFrom?: { attendeeId: string; id: string };
    votes?: ReturnType<typeof voteRow>[];
  } = {},
): EventGameNomination {
  return {
    id: 'nom-1',
    eventId: 'event-1',
    occurrenceId: null,
    platformGameId: 'pg-1',
    nominatedById: 'att-1',
    suppliedFromId: 'gl-1',
    suppliedFrom: { id: 'gl-1', attendeeId: 'att-2' },
    status: NominationStatus.Open,
    pausedFrom: null,
    votingDeadline: null,
    votes: [],
    ...overrides,
  } as EventGameNomination;
}

/** An attendee as the attendee read names them (`ATTENDEE_SUMMARY_SELECT`). */
function attendee(id: string) {
  return {
    id,
    status: EventParticipationStatus.Attending,
    guestName: null,
    user: { id: `user-${id}`, username: `name-${id}`, profile: { displayName: null, avatarUrl: null } },
  };
}
