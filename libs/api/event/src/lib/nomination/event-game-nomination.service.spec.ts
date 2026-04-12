import {
  EventAttendee,
  EventAttendeeGameList,
  EventGame,
  EventGameNomination,
  EventGameVote,
  EventParticipationStatus,
  GameAdditionMode,
  InterestedWeight,
  NominationStatus,
  ScheduledGameRole,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
  VoteType,
} from '@bge/database';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CastVoteDto } from '../dto/cast-vote.dto';
import { NominationEvent } from './constants';
import { NominateGameDto } from './dto/nominate-game.dto';
import { EventGameNominationService } from './event-game-nomination.service';
import type { NominationCreatedEvent, NominationResolvedEvent, VoteCastEvent } from './interfaces';

describe('EventGameNominationService', () => {
  let service: EventGameNominationService;
  let db: MockDatabaseService;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [EventGameNominationService, { provide: EventEmitter2, useValue: eventEmitter }],
    });

    service = module.get(EventGameNominationService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  describe('getNominations', () => {
    it('returns nominations for the event', async () => {
      stubEventExists(db);
      const nominations = [stubNomination()];
      db.eventGameNomination.findMany.mockResolvedValue(nominations);

      const result = await service.getNominations('event-1');

      expect(db.eventGameNomination.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1' } }),
      );
      expect(result).toHaveLength(1);
    });

    it('throws NotFoundException when event does not exist', async () => {
      stubEventExists(db, false);

      await expect(service.getNominations('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('nominate', () => {
    it('creates a nomination with Open status in RequiresVote mode', async () => {
      stubPolicy(db, GameAdditionMode.RequiresVote);

      stubSupplyEntry(db);

      const created = stubNomination({ status: NominationStatus.Open });
      db.eventGameNomination.create.mockResolvedValue(created);

      const dto: NominateGameDto = {
        gameId: 'game-1',
        suppliedFromId: 'eagl-1',
      };
      const result = await service.nominate('event-1', 'att-1', dto);

      expect(db.eventGameNomination.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: NominationStatus.Open,
          }),
        }),
      );
      expect(result).toBe(created);
    });

    it('creates nomination with AwaitingApproval in HostApproval mode', async () => {
      stubPolicy(db, GameAdditionMode.HostApproval);

      stubSupplyEntry(db);

      db.eventGameNomination.create.mockResolvedValue(stubNomination({ status: NominationStatus.AwaitingApproval }));

      await service.nominate('event-1', 'att-1', {
        gameId: 'game-1',
        suppliedFromId: 'eagl-1',
      });

      expect(db.eventGameNomination.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: NominationStatus.AwaitingApproval,
          }),
        }),
      );
    });

    it('creates and immediately elevates in Direct mode', async () => {
      stubPolicy(db, GameAdditionMode.Direct);

      stubSupplyEntry(db);

      const created = stubNomination({ id: 'nom-direct', status: NominationStatus.Passed });

      db.eventGameNomination.create.mockResolvedValue(created);
      db.eventGameNomination.findUniqueOrThrow.mockResolvedValue(stubNomination());
      db.eventGame.create.mockResolvedValue(stubEventGame());

      await service.nominate('event-1', 'att-1', {
        gameId: 'game-1',
        suppliedFromId: 'eagl-1',
      });

      expect(db.eventGame.create).toHaveBeenCalled();
    });

    it('throws ForbiddenException in HostOnly mode', async () => {
      stubPolicy(db, GameAdditionMode.HostOnly);

      await expect(
        service.nominate('event-1', 'att-1', {
          gameId: 'game-1',
          suppliedFromId: 'eagl-1',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when supply entry does not match event', async () => {
      stubPolicy(db, GameAdditionMode.RequiresVote);
      stubSupplyEntry(db, 'other-event', 'game-1');

      await expect(
        service.nominate('event-1', 'att-1', {
          gameId: 'game-1',
          suppliedFromId: 'eagl-1',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when supply gameId mismatches dto gameId', async () => {
      stubPolicy(db, GameAdditionMode.RequiresVote);
      stubSupplyEntry(db, 'event-1', 'wrong-game');

      await expect(
        service.nominate('event-1', 'att-1', {
          gameId: 'game-1',
          suppliedFromId: 'eagl-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('emits NominationCreated domain event', async () => {
      stubPolicy(db, GameAdditionMode.RequiresVote);
      stubSupplyEntry(db);

      db.eventGameNomination.create.mockResolvedValue(stubNomination({ id: 'nom-emit' }));

      await service.nominate('event-1', 'att-1', {
        gameId: 'game-1',
        suppliedFromId: 'eagl-1',
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NominationEvent.NominationCreated,
        expect.objectContaining({
          eventId: 'event-1',
          nominationId: 'nom-emit',
          gameId: 'game-1',
          nominatedByAttendeeId: 'att-1',
        } satisfies NominationCreatedEvent),
      );
    });
  });

  describe('withdraw', () => {
    it('withdraws an Open nomination', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(stubNomination({ nominatedById: 'att-1' }));
      const updated = stubNomination({ status: NominationStatus.Withdrawn });
      db.eventGameNomination.update.mockResolvedValue(updated);

      const result = await service.withdraw('event-1', 'nom-1', 'att-1');

      expect(result.status).toBe(NominationStatus.Withdrawn);
    });

    it('throws ForbiddenException when not the nominator', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(stubNomination({ nominatedById: 'att-1' }));

      await expect(service.withdraw('event-1', 'nom-1', 'att-other')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when nomination is already resolved', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        stubNomination({ nominatedById: 'att-1', status: NominationStatus.Passed }),
      );

      await expect(service.withdraw('event-1', 'nom-1', 'att-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('castVote', () => {
    it('upserts a vote on an Open nomination', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(stubNomination());
      const vote = stubEventGameVote({ voteType: VoteType.For });
      db.eventGameVote.upsert.mockResolvedValue(vote);

      const dto: CastVoteDto = { voteType: VoteType.For };
      const result = await service.castVote('event-1', 'nom-1', 'att-1', dto);

      expect(db.eventGameVote.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            eventGameNominationId_attendeeId: {
              eventGameNominationId: 'nom-1',
              attendeeId: 'att-1',
            },
          },
        }),
      );
      expect(result).toBe(vote);
    });

    it('emits VoteCast domain event', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(stubNomination());
      db.eventGameVote.upsert.mockResolvedValue(stubEventGameVote({ voteType: VoteType.Against }));

      await service.castVote('event-1', 'nom-1', 'att-1', {
        voteType: VoteType.Against,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NominationEvent.VoteCast,
        expect.objectContaining({
          eventId: 'event-1',
          nominationId: 'nom-1',
          attendeeId: 'att-1',
          voteType: VoteType.Against,
        } satisfies VoteCastEvent),
      );
    });

    it('throws BadRequestException when nomination is not Open', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        stubNomination({ status: NominationStatus.AwaitingApproval }),
      );

      await expect(
        service.castVote('event-1', 'nom-1', 'user-1', {
          voteType: VoteType.For,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when nomination does not exist', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(null);

      await expect(
        service.castVote('event-1', 'nonexistent', 'user-1', {
          voteType: VoteType.For,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolveNomination', () => {
    it('resolves a passing vote and elevates to EventGame', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        stubNomination({
          votes: [{ voteType: VoteType.For }, { voteType: VoteType.For }],
        }),
      );
      stubPolicy(db, GameAdditionMode.RequiresVote);

      db.eventAttendee.findMany.mockResolvedValue([stubAttendeeWithGames(), stubAttendeeWithGames()]);
      db.eventGameNomination.update.mockResolvedValue(stubNomination({ status: NominationStatus.Passed }));
      db.eventGameNomination.findUniqueOrThrow.mockResolvedValue(stubNomination());
      db.eventGame.create.mockResolvedValue(stubEventGame({ id: 'eg-elevated' }));

      const { resolution } = await service.resolveNomination('event-1', 'nom-1');

      expect(resolution.status).toBe(NominationStatus.Passed);
      expect(resolution.thresholdMet).toBe(true);
      expect(db.eventGame.create).toHaveBeenCalled();
    });

    it('resolves a failing vote without elevation', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        stubNomination({
          votes: [{ voteType: VoteType.Against }, { voteType: VoteType.Against }, { voteType: VoteType.For }],
        }),
      );
      stubPolicy(db, GameAdditionMode.RequiresVote);

      db.eventAttendee.findMany.mockResolvedValue([
        stubAttendeeWithGames(),
        stubAttendeeWithGames(),
        stubAttendeeWithGames(),
      ]);
      db.eventGameNomination.update.mockResolvedValue(stubNomination({ status: NominationStatus.Failed }));

      const { resolution } = await service.resolveNomination('event-1', 'nom-1');

      expect(resolution.status).toBe(NominationStatus.Failed);
      expect(db.eventGame.create).not.toHaveBeenCalled();
    });

    it('emits NominationResolved domain event', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        stubNomination({
          votes: [{ voteType: VoteType.Against }],
        }),
      );
      stubPolicy(db);

      db.eventAttendee.findMany.mockResolvedValue([stubAttendeeWithGames()]);
      db.eventGameNomination.update.mockResolvedValue(stubNomination({ status: NominationStatus.Failed }));

      await service.resolveNomination('event-1', 'nom-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NominationEvent.NominationResolved,
        expect.objectContaining({
          eventId: 'event-1',
          nominationId: 'nom-1',
          status: NominationStatus.Failed,
        } satisfies Partial<NominationResolvedEvent>),
      );
    });

    it('throws BadRequestException when nomination is not Open', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(stubNomination({ status: NominationStatus.Passed }));

      await expect(service.resolveNomination('event-1', 'nom-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('hostApprove', () => {
    it('approves an AwaitingApproval nomination and elevates', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        stubNomination({ status: NominationStatus.AwaitingApproval }),
      );
      db.eventGameNomination.update.mockResolvedValue(stubNomination({ status: NominationStatus.Approved }));
      db.eventGameNomination.findUniqueOrThrow.mockResolvedValue(stubNomination());
      db.eventGame.create.mockResolvedValue(stubEventGame({ id: 'eg-approved' }));

      await service.hostApprove('event-1', 'nom-1');

      expect(db.eventGameNomination.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: NominationStatus.Approved },
        }),
      );
      expect(db.eventGame.create).toHaveBeenCalled();
    });

    it('throws BadRequestException when not AwaitingApproval', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(stubNomination({ status: NominationStatus.Open }));

      await expect(service.hostApprove('event-1', 'nom-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('hostReject', () => {
    it('rejects an AwaitingApproval nomination without elevation', async () => {
      db.eventGameNomination.findUnique.mockResolvedValue(
        stubNomination({ status: NominationStatus.AwaitingApproval }),
      );
      db.eventGameNomination.update.mockResolvedValue(stubNomination({ status: NominationStatus.Rejected }));

      await service.hostReject('event-1', 'nom-1');

      expect(db.eventGame.create).not.toHaveBeenCalled();
    });
  });

  describe('directAddGame', () => {
    it('creates an EventGame directly in Direct mode', async () => {
      stubPolicy(db, GameAdditionMode.Direct);

      db.eventGame.create.mockResolvedValue(stubEventGame({ id: 'eg-direct', gameId: 'game-1' }));

      const result = await service.directAddGame('event-1', 'att-1', {
        gameId: 'game-1',
        suppliedById: 'eagl-1',
      });

      expect(db.eventGame.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            game: { connect: { id: 'game-1' } },
            suppliedBy: { connect: { id: 'eagl-1' } },
            addedBy: { connect: { id: 'att-1' } },
          }),
        }),
      );
      expect(result.id).toBe('eg-direct');
    });

    it('throws ForbiddenException in RequiresVote mode', async () => {
      stubPolicy(db, GameAdditionMode.RequiresVote);

      await expect(
        service.directAddGame('event-1', 'att-1', {
          gameId: 'game-1',
          suppliedById: 'eagl-1',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('emits GameAddedToEvent domain event', async () => {
      stubPolicy(db, GameAdditionMode.Direct);

      db.eventGame.create.mockResolvedValue(stubEventGame({ id: 'eg-emit', gameId: 'game-1' }));

      await service.directAddGame('event-1', 'att-1', {
        gameId: 'game-1',
        suppliedById: 'eagl-1',
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NominationEvent.GameAddedToEvent,
        expect.objectContaining({
          eventId: 'event-1',
          eventGameId: 'eg-emit',
          gameId: 'game-1',
        }),
      );
    });
  });
});

function stubEventExists(db: MockDatabaseService, exists = true): void {
  db.event.count.mockResolvedValue(exists ? 1 : 0);
}

function stubPolicy(db: MockDatabaseService, mode: GameAdditionMode = GameAdditionMode.RequiresVote) {
  db.eventPolicy.findUnique.mockResolvedValue({
    id: 'policy-1',
    eventId: 'event-1',
    allowMemberInvites: true,
    allowGuestInvites: true,
    maxAttendees: null,
    restrictToGameCategories: false,
    requireHostApprovalToJoin: false,
    allowSpectators: true,
    maxTotalParticipants: null,
    strictCapacity: false,
    gameAdditionMode: mode,
    restrictToAttendeePool: true,
    fillerMaxPlayTime: null,
    voteThresholdType: VoteThresholdType.SimpleMajority,
    voteThresholdValue: null,
    voteQuorumType: VoteQuorumType.None,
    voteQuorumValue: null,
    voteEligibility: VoteEligibility.ConfirmedOnly,
    interestedWeight: InterestedWeight.AsAbstain,
    votingWindowHours: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  db.eventOccurrencePolicy.findUnique.mockResolvedValue(null);
}

function stubSupplyEntry(db: MockDatabaseService, eventId = 'event-1', gameId = 'game-1') {
  const entry: EventAttendeeGameList & { attendee: { eventId: string }; collection: { gameId: string } } = {
    id: 'eagl-1',
    attendeeId: 'att-1',
    collectionId: 'ce-1',
    createdAt: new Date(),
    attendee: { eventId },
    collection: { gameId },
  };
  db.eventAttendeeGameList.findUnique.mockResolvedValue(entry);
}

function stubNomination(overrides: Partial<EventGameNomination & { votes: { voteType: VoteType }[] }> = {}) {
  return {
    id: 'nom-1',
    eventId: 'event-1',
    gameId: 'game-1',
    nominatedById: 'att-1',
    suppliedFromId: 'eagl-1',
    occurrenceId: null,
    status: NominationStatus.Open,
    votingDeadline: null,
    votes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function stubEventGame(overrides: Partial<EventGame> = {}): EventGame {
  return {
    id: 'eg-1',
    eventId: 'event-1',
    occurrenceId: null,
    gameId: 'game-1',
    role: ScheduledGameRole.Primary,
    sortOrder: 0,
    notes: null,
    maxPlayTime: null,
    suppliedById: 'eagl-1',
    nominationId: null,
    addedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function stubEventGameVote(overrides: Partial<EventGameVote> = {}): EventGameVote {
  return {
    id: 'vote-1',
    eventGameNominationId: 'nom-1',
    attendeeId: 'att-1',
    occurrenceId: null,
    voteType: VoteType.For,
    priority: null,
    comment: null,
    ...overrides,
  };
}

function stubAttendeeWithGames(
  overrides: Partial<EventAttendee & { availableGames: EventAttendeeGameList[] }> = {},
): EventAttendee & { availableGames: EventAttendeeGameList[] } {
  return {
    id: 'att-stub',
    eventId: 'event-1',
    userId: null,
    guestName: null,
    guestEmail: null,
    status: EventParticipationStatus.Attending,
    invitedById: null,
    notes: null,
    rsvpDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    availableGames: [],
    ...overrides,
  };
}
