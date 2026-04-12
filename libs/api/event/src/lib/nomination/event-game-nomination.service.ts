import {
  DatabaseService,
  EventGame,
  EventGameNomination,
  EventGameVote,
  GameAdditionMode,
  InterestedWeight,
  NominationStatus,
  ScheduledGameRole,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
} from '@bge/database';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { CastVoteDto } from '../dto/cast-vote.dto';
import { ResolutionResult, VotingPolicy } from '../interfaces/vote.interface';
import { VoteResolver } from '../vote/vote-resolver';
import { NominationEvent } from './constants';
import { DirectAddGameDto } from './dto/direct-add-game.dto';
import { NominateGameDto } from './dto/nominate-game.dto';
import type {
  GameAddedToEventPayload,
  NominationCreatedEvent,
  NominationResolvedEvent,
  VoteCastEvent,
} from './interfaces';

@Injectable()
export class EventGameNominationService {
  private readonly logger = new Logger(EventGameNominationService.name);

  constructor(private readonly db: DatabaseService, private readonly eventEmitter: EventEmitter2) {}

  async getNominations(eventId: string): Promise<EventGameNomination[]> {
    await this.assertEventExists(eventId);

    return this.db.eventGameNomination.findMany({
      where: { eventId },
      include: NOMINATION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getNomination(eventId: string, nominationId: string): Promise<EventGameNomination> {
    await this.assertEventExists(eventId);

    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      include: NOMINATION_INCLUDE,
    });

    assert(nomination, new NotFoundException(`Nomination ${nominationId} not found for event ${eventId}`));
    return nomination;
  }

  async nominate(eventId: string, attendeeId: string, dto: NominateGameDto): Promise<EventGameNomination> {
    const policy = await this.getEffectivePolicy(eventId, dto.occurrenceId);

    if (policy.gameAdditionMode === GameAdditionMode.HostOnly) {
      throw new ForbiddenException('Only hosts can add games in HostOnly mode.');
    }

    // Validate the supplied-from game list entry exists and matches
    const supplyEntry = await this.db.eventAttendeeGameList.findUnique({
      where: { id: dto.suppliedFromId },
      select: {
        id: true,
        attendee: { select: { eventId: true } },
        collection: { select: { gameId: true } },
      },
    });

    if (supplyEntry?.attendee?.eventId !== eventId) {
      throw new NotFoundException(`Game list entry ${dto.suppliedFromId} not found for this event.`);
    }

    if (supplyEntry.collection.gameId !== dto.gameId) {
      throw new BadRequestException('The suppliedFromId does not correspond to the nominated gameId.');
    }

    // Determine initial status based on policy mode
    let initialStatus: NominationStatus;
    let votingDeadline: Date | undefined;

    switch (policy.gameAdditionMode) {
      case GameAdditionMode.RequiresVote: {
        initialStatus = NominationStatus.Open;

        if (policy.votingWindowHours) {
          votingDeadline = new Date(Date.now() + policy.votingWindowHours * 60 * 60 * 1000);
        }

        break;
      }

      case GameAdditionMode.HostApproval: {
        initialStatus = NominationStatus.AwaitingApproval;
        break;
      }

      case GameAdditionMode.Direct: {
        // For Direct mode, nomination is created and immediately elevated
        initialStatus = NominationStatus.Passed;
        break;
      }

      default: {
        initialStatus = NominationStatus.Open;
      }
    }

    const nomination = await this.db.eventGameNomination.create({
      data: {
        event: { connect: { id: eventId } },
        occurrence: dto.occurrenceId ? { connect: { id: dto.occurrenceId } } : undefined,
        game: { connect: { id: dto.gameId } },
        nominatedBy: { connect: { id: attendeeId } },
        suppliedFrom: { connect: { id: dto.suppliedFromId } },
        status: initialStatus,
        votingDeadline,
      },
      include: NOMINATION_INCLUDE,
    });

    this.eventEmitter.emit(NominationEvent.NominationCreated, {
      eventId,
      nominationId: nomination.id,
      gameId: dto.gameId,
      nominatedByAttendeeId: attendeeId,
    } satisfies NominationCreatedEvent);

    // In Direct mode, immediately elevate to EventGame
    if (policy.gameAdditionMode === GameAdditionMode.Direct) {
      await this.elevateToEventGame(nomination.id, eventId, dto.occurrenceId);
    }

    return nomination;
  }

  async withdraw(eventId: string, nominationId: string, attendeeId: string): Promise<EventGameNomination> {
    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: { id: true, nominatedById: true, status: true },
    });

    assert(nomination, new NotFoundException(`Nomination ${nominationId} not found for event ${eventId}`));
    assert(
      nomination.nominatedById === attendeeId,
      new ForbiddenException('Only the nominator can withdraw a nomination.'),
    );

    const withdrawable: NominationStatus[] = [NominationStatus.Open, NominationStatus.AwaitingApproval];
    assert(
      withdrawable.includes(nomination.status),
      new BadRequestException(`Cannot withdraw a nomination with status "${nomination.status}".`),
    );

    const updated = await this.db.eventGameNomination.update({
      where: { id: nominationId },
      data: { status: NominationStatus.Withdrawn },
      include: NOMINATION_INCLUDE,
    });

    this.eventEmitter.emit(NominationEvent.NominationWithdrawn, {
      eventId,
      nominationId,
    });

    return updated;
  }

  async castVote(eventId: string, nominationId: string, attendeeId: string, dto: CastVoteDto): Promise<EventGameVote> {
    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: { id: true, status: true },
    });

    assert(nomination, new NotFoundException(`Nomination ${nominationId} not found for event ${eventId}`));
    assert(
      nomination.status === NominationStatus.Open,
      new BadRequestException(`Cannot vote on a nomination with status "${nomination.status}".`),
    );

    try {
      // Upsert the vote to allow changing an existing vote or creating a new one
      const vote = await this.db.eventGameVote.upsert({
        where: {
          eventGameNominationId_attendeeId: {
            eventGameNominationId: nominationId,
            attendeeId,
          },
        },
        create: {
          nomination: { connect: { id: nominationId } },
          attendee: { connect: { id: attendeeId } },
          voteType: dto.voteType,
          priority: dto.priority,
          comment: dto.comment,
        },
        update: {
          voteType: dto.voteType,
          priority: dto.priority,
          comment: dto.comment,
        },
      });

      this.eventEmitter.emit(NominationEvent.VoteCast, {
        eventId,
        nominationId,
        attendeeId,
        voteType: dto.voteType,
      } satisfies VoteCastEvent);

      return vote;
    } catch (error) {
      this.logger.error(`Error casting vote on nomination ${nominationId}`, error);
      throw error;
    }
  }

  async resolveNomination(
    eventId: string,
    nominationId: string,
  ): Promise<{ nomination: EventGameNomination; resolution: ResolutionResult }> {
    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: {
        id: true,
        status: true,
        gameId: true,
        occurrenceId: true,
        votes: { select: { voteType: true } },
      },
    });

    assert(nomination, new NotFoundException(`Nomination ${nominationId} not found for event ${eventId}`));
    assert(
      nomination.status === NominationStatus.Open,
      new BadRequestException(`Cannot resolve a nomination with status "${nomination.status}".`),
    );

    const policy = await this.getEffectivePolicy(eventId, nomination.occurrenceId ?? undefined);
    const attendees = await this.db.eventAttendee.findMany({
      where: { eventId },
      select: {
        status: true,
        availableGames: { select: { id: true } },
      },
    });

    const resolution = VoteResolver.resolve(nomination.votes, policy, attendees);

    const updated = await this.db.eventGameNomination.update({
      where: { id: nominationId },
      data: { status: resolution.status },
      include: NOMINATION_INCLUDE,
    });

    let elevatedGameId: string | null = null;

    if (resolution.status === NominationStatus.Passed) {
      const eventGame = await this.elevateToEventGame(nominationId, eventId, nomination.occurrenceId ?? undefined);
      elevatedGameId = eventGame.id;
    }

    this.eventEmitter.emit(NominationEvent.NominationResolved, {
      eventId,
      nominationId,
      gameId: nomination.gameId,
      status: resolution.status,
      elevatedToEventGameId: elevatedGameId,
    } satisfies NominationResolvedEvent);

    return { nomination: updated, resolution };
  }

  async hostApprove(eventId: string, nominationId: string): Promise<EventGameNomination> {
    return this.hostDecision(eventId, nominationId, NominationStatus.Approved);
  }

  async hostReject(eventId: string, nominationId: string): Promise<EventGameNomination> {
    return this.hostDecision(eventId, nominationId, NominationStatus.Rejected);
  }

  private async hostDecision(
    eventId: string,
    nominationId: string,
    decision: NominationStatus,
  ): Promise<EventGameNomination> {
    if (decision !== NominationStatus.Approved && decision !== NominationStatus.Rejected) {
      throw new BadRequestException('Invalid decision for host approval. Must be "Approved" or "Rejected".');
    }

    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: {
        id: true,
        status: true,
        gameId: true,
        occurrenceId: true,
      },
    });

    assert(nomination, new NotFoundException(`Nomination ${nominationId} not found for event ${eventId}`));
    assert(
      nomination.status === NominationStatus.AwaitingApproval,
      new BadRequestException(
        `Cannot approve/reject a nomination with status "${nomination.status}". ` +
          'Only nominations in AwaitingApproval status can be decided by the host.',
      ),
    );

    const updated = await this.db.eventGameNomination.update({
      where: { id: nominationId },
      data: { status: decision },
      include: NOMINATION_INCLUDE,
    });

    let elevatedGameId: string | null = null;
    if (decision === NominationStatus.Approved) {
      const eventGame = await this.elevateToEventGame(nominationId, eventId, nomination.occurrenceId ?? undefined);
      elevatedGameId = eventGame.id;
    }

    this.eventEmitter.emit(NominationEvent.NominationResolved, {
      eventId,
      nominationId,
      gameId: nomination.gameId,
      status: decision,
      elevatedToEventGameId: elevatedGameId,
    } satisfies NominationResolvedEvent);

    return updated;
  }

  async directAddGame(eventId: string, attendeeId: string, dto: DirectAddGameDto): Promise<EventGame> {
    const policy = await this.getEffectivePolicy(eventId, dto.occurrenceId);

    if (policy.gameAdditionMode !== GameAdditionMode.Direct && policy.gameAdditionMode !== GameAdditionMode.HostOnly) {
      throw new ForbiddenException(`Direct game addition is not permitted in "${policy.gameAdditionMode}" mode.`);
    }

    // Validate exactly one of eventId or occurrenceId is used
    const eventGame = await this.db.eventGame.create({
      data: {
        event: dto.occurrenceId ? undefined : { connect: { id: eventId } },
        occurrence: dto.occurrenceId ? { connect: { id: dto.occurrenceId } } : undefined,
        game: { connect: { id: dto.gameId } },
        suppliedBy: { connect: { id: dto.suppliedById } },
        addedBy: { connect: { id: attendeeId } },
        role: dto.role ?? ScheduledGameRole.Primary,
        sortOrder: dto.sortOrder ?? 0,
        notes: dto.notes,
        maxPlayTime: dto.maxPlayTime,
      },
    });

    this.eventEmitter.emit(NominationEvent.GameAddedToEvent, {
      eventId,
      eventGameId: eventGame.id,
      gameId: dto.gameId,
      addedByAttendeeId: attendeeId,
    } satisfies GameAddedToEventPayload);

    return eventGame;
  }

  /**
   * Create an EventGame record from a successful nomination.
   */
  private async elevateToEventGame(nominationId: string, eventId: string, occurrenceId?: string): Promise<EventGame> {
    const nomination = await this.db.eventGameNomination.findUniqueOrThrow({
      where: { id: nominationId },
      select: { gameId: true, suppliedFromId: true, nominatedById: true },
    });

    const eventGame = await this.db.eventGame.create({
      data: {
        event: occurrenceId ? undefined : { connect: { id: eventId } },
        occurrence: occurrenceId ? { connect: { id: occurrenceId } } : undefined,
        game: { connect: { id: nomination.gameId } },
        suppliedBy: { connect: { id: nomination.suppliedFromId } },
        nomination: { connect: { id: nominationId } },
        role: ScheduledGameRole.Primary,
      },
    });

    this.eventEmitter.emit(NominationEvent.GameAddedToEvent, {
      eventId,
      eventGameId: eventGame.id,
      gameId: nomination.gameId,
      addedByAttendeeId: nomination.nominatedById,
    } satisfies GameAddedToEventPayload);

    return eventGame;
  }

  /**
   * Resolve the effective voting policy for a given context.
   * Occurrence-level policy fields override event-level when non-null.
   */
  private async getEffectivePolicy(
    eventId: string,
    occurrenceId?: string,
  ): Promise<VotingPolicy & { gameAdditionMode: GameAdditionMode; votingWindowHours: number | null }> {
    const eventPolicy = await this.db.eventPolicy.findUnique({
      where: { eventId },
    });

    // Default policy if none exists
    const base = {
      gameAdditionMode: eventPolicy?.gameAdditionMode ?? GameAdditionMode.Direct,
      voteThresholdType: eventPolicy?.voteThresholdType ?? VoteThresholdType.SimpleMajority,
      voteThresholdValue: eventPolicy?.voteThresholdValue ?? null,
      voteQuorumType: eventPolicy?.voteQuorumType ?? VoteQuorumType.None,
      voteQuorumValue: eventPolicy?.voteQuorumValue ?? null,
      voteEligibility: eventPolicy?.voteEligibility ?? VoteEligibility.ConfirmedOnly,
      interestedWeight: eventPolicy?.interestedWeight ?? InterestedWeight.AsAbstain,
      votingWindowHours: eventPolicy?.votingWindowHours ?? null,
    };

    if (!occurrenceId) {
      return base;
    }

    const occPolicy = await this.db.eventOccurrencePolicy.findUnique({
      where: { occurrenceId },
    });

    if (!occPolicy) {
      return base;
    }

    return {
      gameAdditionMode: occPolicy.gameAdditionMode ?? base.gameAdditionMode,
      voteThresholdType: occPolicy.voteThresholdType ?? base.voteThresholdType,
      voteThresholdValue: occPolicy.voteThresholdValue ?? base.voteThresholdValue,
      voteQuorumType: occPolicy.voteQuorumType ?? base.voteQuorumType,
      voteQuorumValue: occPolicy.voteQuorumValue ?? base.voteQuorumValue,
      voteEligibility: occPolicy.voteEligibility ?? base.voteEligibility,
      interestedWeight: occPolicy.interestedWeight ?? base.interestedWeight,
      votingWindowHours: occPolicy.votingWindowHours ?? base.votingWindowHours,
    };
  }

  private async assertEventExists(eventId: string): Promise<void> {
    const count = await this.db.event.count({
      where: { id: eventId, deletedAt: null },
    });
    assert(count > 0, new NotFoundException(`Event ${eventId} not found`));
  }
}

const NOMINATION_INCLUDE = {
  game: { select: { id: true, title: true, thumbnail: true } },
  nominatedBy: {
    select: {
      id: true,
      attendeeId: true,
      user: { select: { id: true, username: true } },
    },
  },
  suppliedFrom: {
    select: {
      id: true,
      collection: {
        select: {
          game: { select: { id: true, title: true } },
        },
      },
    },
  },
  votes: {
    select: {
      id: true,
      attendeeId: true,
      voteType: true,
      priority: true,
      comment: true,
    },
  },
} as const;
