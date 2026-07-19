import {
  Action,
  DatabaseService,
  EventGame,
  EventGameNomination,
  EventGameVote,
  GameAdditionMode,
  InterestedWeight,
  isPrismaDependentRecordNotFoundError,
  NominationStatus,
  ResourceType,
  ScheduledGameRole,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { CastVoteDto } from '../dto/cast-vote.dto';
import { assertEventExists, resolveActingAttendeeId } from '../event-access.helpers';
import { ResolutionResult, VotingPolicy } from '../interfaces/vote.interface';
import { AttendeeStub, VoteResolver } from '../vote/vote-resolver';
import { DirectAddGameDto } from './dto/direct-add-game.dto';
import { NominateGameDto } from './dto/nominate-game.dto';
import {
  GameAddedToEventEvent,
  NominationCreatedEvent,
  NominationResolvedEvent,
  NominationWithdrawnEvent,
  VoteCastEvent,
} from './events/nomination.events';

@Injectable()
export class EventGameNominationService {
  private readonly logger = new Logger(EventGameNominationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly abilityService: AbilityService,
  ) {}

  async getNominations(eventId: string): Promise<EventGameNomination[]> {
    await assertEventExists(this.db, eventId);

    return this.db.eventGameNomination.findMany({
      where: {
        eventId,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGameNomination, Action.read),
      },
      include: NOMINATION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getNomination(eventId: string, nominationId: string): Promise<EventGameNomination> {
    await assertEventExists(this.db, eventId);

    const nomination = await this.db.eventGameNomination.findUnique({
      where: {
        id: nominationId,
        eventId,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGameNomination, Action.read),
      },
      include: NOMINATION_INCLUDE,
    });

    assert(nomination, new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId })));
    return nomination;
  }

  async nominate(eventId: string, dto: NominateGameDto): Promise<EventGameNomination> {
    const initiatedAt = new Date();
    const attendeeId = await resolveActingAttendeeId(this.db, this.abilityService, eventId);
    const policy = await this.getEffectivePolicy(eventId, dto.occurrenceId);

    if (policy.gameAdditionMode === GameAdditionMode.HostOnly) {
      throw new ForbiddenException(t('errors.nomination.host_only'));
    }

    const supplyEntry = await this.db.eventAttendeeGameList.findUnique({
      where: { id: dto.suppliedFromId },
      select: {
        id: true,
        attendee: { select: { eventId: true } },
        collection: { select: { platformGameId: true } },
      },
    });

    if (supplyEntry?.attendee?.eventId !== eventId) {
      throw new NotFoundException(t('errors.nomination.supplied_from_not_found', { suppliedFromId: dto.suppliedFromId }));
    }

    if (supplyEntry.collection.platformGameId !== dto.platformGameId) {
      throw new BadRequestException(t('errors.nomination.supplied_from_mismatch'));
    }

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
        initialStatus = NominationStatus.Passed;
        break;
      }

      default: {
        initialStatus = NominationStatus.Open;
      }
    }

    this.logger.debug(`Creating nomination for event ${eventId} with initial status ${initialStatus}`);

    const nomination = await this.db.eventGameNomination.create({
      data: {
        event: { connect: { id: eventId } },
        occurrence: dto.occurrenceId ? { connect: { id: dto.occurrenceId } } : undefined,
        platformGame: { connect: { id: dto.platformGameId } },
        nominatedBy: { connect: { id: attendeeId } },
        suppliedFrom: { connect: { id: dto.suppliedFromId } },
        status: initialStatus,
        votingDeadline,
      },
      include: NOMINATION_INCLUDE,
    });

    this.eventEmitter.emit(
      NominationCreatedEvent.eventName,
      new NominationCreatedEvent(
        {
          id: nomination.id,
          eventId: nomination.eventId,
          occurrenceId: nomination.occurrenceId,
          platformGameId: nomination.platformGameId,
          nominatedById: nomination.nominatedById,
          suppliedFromId: nomination.suppliedFromId,
          status: nomination.status,
          votingDeadline: nomination.votingDeadline,
        },
        initiatedAt,
      ),
    );

    if (policy.gameAdditionMode === GameAdditionMode.Direct) {
      await this.elevateToEventGame(nomination.id, eventId, dto.occurrenceId);
    }

    return nomination;
  }

  async withdraw(eventId: string, nominationId: string): Promise<EventGameNomination> {
    const initiatedAt = new Date();
    const attendeeId = await resolveActingAttendeeId(this.db, this.abilityService, eventId);

    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: { id: true, nominatedById: true, status: true },
    });

    assert(nomination, new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId })));
    assert(
      nomination.nominatedById === attendeeId,
      new ForbiddenException(t('errors.nomination.only_nominator_withdraw')),
    );

    const withdrawable: NominationStatus[] = [NominationStatus.Open, NominationStatus.AwaitingApproval];
    assert(
      withdrawable.includes(nomination.status),
      new BadRequestException(t('errors.nomination.cannot_withdraw_status', { status: nomination.status })),
    );

    try {
      const updated = await this.db.eventGameNomination.update({
        where: {
          id: nominationId,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGameNomination, Action.update),
        },
        data: { status: NominationStatus.Withdrawn },
        include: NOMINATION_INCLUDE,
      });

      this.eventEmitter.emit(
        NominationWithdrawnEvent.eventName,
        new NominationWithdrawnEvent(
          { id: nominationId, eventId, status: nomination.status },
          { id: updated.id, eventId: updated.eventId, status: updated.status },
          initiatedAt,
        ),
      );

      return updated;
    } catch (error) {
      this.logger.error(`Error withdrawing nomination ${nominationId} for event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.nomination.forbidden_withdraw'));
      }
      throw error;
    }
  }

  async castVote(eventId: string, nominationId: string, dto: CastVoteDto): Promise<EventGameVote> {
    const initiatedAt = new Date();
    const attendeeId = await resolveActingAttendeeId(this.db, this.abilityService, eventId);
    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: { id: true, status: true },
    });

    assert(nomination, new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId })));
    assert(
      nomination.status === NominationStatus.Open,
      new BadRequestException(t('errors.nomination.cannot_vote_status', { status: nomination.status })),
    );

    try {
      // Pre-read classifies create vs update for the audit before-snapshot.
      // Best-effort, not transactional: the unique (nomination, attendee) key
      // means only the same attendee can race this row (double-submit / retry),
      // and in that narrow window the event may label a re-vote as a create or
      // carry a slightly stale before. The upsert itself is always correct.
      const existingVote = await this.db.eventGameVote.findUnique({
        where: {
          eventGameNominationId_attendeeId: {
            eventGameNominationId: nominationId,
            attendeeId,
          },
        },
        select: { id: true, voteType: true, priority: true, comment: true },
      });

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

      this.eventEmitter.emit(
        VoteCastEvent.eventName,
        new VoteCastEvent(
          existingVote
            ? {
                id: existingVote.id,
                voteType: existingVote.voteType,
                priority: existingVote.priority,
                comment: existingVote.comment,
              }
            : null,
          existingVote
            ? { id: vote.id, voteType: vote.voteType, priority: vote.priority, comment: vote.comment }
            : {
                id: vote.id,
                eventGameNominationId: vote.eventGameNominationId,
                attendeeId: vote.attendeeId,
                voteType: vote.voteType,
                priority: vote.priority,
                comment: vote.comment,
              },
          initiatedAt,
        ),
      );

      return vote;
    } catch (error: unknown) {
      this.logger.error(`Failed to cast vote for nomination ${nominationId} in event ${eventId}: ${error}`, {
        error,
      });

      throw new BadRequestException(t('errors.nomination.vote_failed'));
    }
  }

  async resolveNomination(
    eventId: string,
    nominationId: string,
  ): Promise<{ nomination: EventGameNomination; resolution: ResolutionResult }> {
    const initiatedAt = new Date();
    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: {
        id: true,
        status: true,
        platformGameId: true,
        occurrenceId: true,
        votes: { select: { voteType: true } },
      },
    });

    assert(nomination, new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId })));
    assert(
      nomination.status === NominationStatus.Open,
      new BadRequestException(t('errors.nomination.cannot_resolve_status', { status: nomination.status })),
    );

    const policy = await this.getEffectivePolicy(eventId, nomination.occurrenceId ?? undefined);
    const attendees = await this.getEventAttendees(eventId);

    const resolution = VoteResolver.resolve(nomination.votes, policy, attendees);
    const resolvedStatus = resolution.thresholdMet ? NominationStatus.Passed : NominationStatus.Failed;

    try {
      const updated = await this.db.eventGameNomination.update({
        where: {
          id: nominationId,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGameNomination, Action.update),
        },
        data: { status: resolvedStatus },
        include: NOMINATION_INCLUDE,
      });

      let elevatedGameId: string | null = null;
      if (resolution.thresholdMet) {
        const eventGame = await this.elevateToEventGame(nominationId, eventId, nomination.occurrenceId ?? undefined);
        elevatedGameId = eventGame.id;
      }

      this.eventEmitter.emit(
        NominationResolvedEvent.eventName,
        new NominationResolvedEvent(
          { id: nominationId, eventId, platformGameId: nomination.platformGameId, status: nomination.status },
          { id: updated.id, eventId: updated.eventId, platformGameId: updated.platformGameId, status: updated.status },
          elevatedGameId,
          initiatedAt,
        ),
      );

      return { nomination: updated, resolution: { ...resolution, status: resolvedStatus } };
    } catch (error) {
      this.logger.error(`Error resolving nomination ${nominationId} for event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.nomination.forbidden_resolve'));
      }
      throw error;
    }
  }

  hostApprove(eventId: string, nominationId: string): Promise<EventGameNomination> {
    return this.handleHostDecision(eventId, nominationId, NominationStatus.Approved);
  }

  hostReject(eventId: string, nominationId: string): Promise<EventGameNomination> {
    return this.handleHostDecision(eventId, nominationId, NominationStatus.Rejected);
  }

  private async handleHostDecision(
    eventId: string,
    nominationId: string,
    decision: NominationStatus,
  ): Promise<EventGameNomination> {
    const initiatedAt = new Date();
    if (decision !== NominationStatus.Approved && decision !== NominationStatus.Rejected) {
      throw new BadRequestException(t('errors.nomination.invalid_resolution'));
    }

    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: {
        id: true,
        status: true,
        platformGameId: true,
        occurrenceId: true,
      },
    });

    assert(nomination, new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId })));
    assert(
      nomination.status === NominationStatus.AwaitingApproval,
      new BadRequestException(t('errors.nomination.cannot_decide_status', { status: nomination.status })),
    );

    try {
      const updated = await this.db.eventGameNomination.update({
        where: {
          id: nominationId,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGameNomination, Action.update),
        },
        data: { status: decision },
        include: NOMINATION_INCLUDE,
      });

      let elevatedGameId: string | null = null;
      if (decision === NominationStatus.Approved) {
        const eventGame = await this.elevateToEventGame(nominationId, eventId, nomination.occurrenceId ?? undefined);
        elevatedGameId = eventGame.id;
      }

      this.eventEmitter.emit(
        NominationResolvedEvent.eventName,
        new NominationResolvedEvent(
          { id: nominationId, eventId, platformGameId: nomination.platformGameId, status: nomination.status },
          { id: updated.id, eventId: updated.eventId, platformGameId: updated.platformGameId, status: updated.status },
          elevatedGameId,
          initiatedAt,
        ),
      );

      return updated;
    } catch (error) {
      this.logger.error(`Error applying host decision ${decision} for nomination ${nominationId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.nomination.forbidden_decide'));
      }
      throw error;
    }
  }

  async directAddGame(eventId: string, dto: DirectAddGameDto): Promise<EventGame> {
    const initiatedAt = new Date();
    const attendeeId = await resolveActingAttendeeId(this.db, this.abilityService, eventId);
    const policy = await this.getEffectivePolicy(eventId, dto.occurrenceId);

    if (policy.gameAdditionMode !== GameAdditionMode.Direct && policy.gameAdditionMode !== GameAdditionMode.HostOnly) {
      throw new ForbiddenException(t('errors.nomination.direct_add_not_permitted', { mode: policy.gameAdditionMode }));
    }

    const eventGame = await this.db.eventGame.create({
      data: {
        event: dto.occurrenceId ? undefined : { connect: { id: eventId } },
        occurrence: dto.occurrenceId ? { connect: { id: dto.occurrenceId } } : undefined,
        platformGame: { connect: { id: dto.platformGameId } },
        suppliedBy: { connect: { id: dto.suppliedById } },
        addedBy: { connect: { id: attendeeId } },
        role: dto.role ?? ScheduledGameRole.Primary,
        sortOrder: dto.sortOrder ?? 0,
        notes: dto.notes,
        maxPlayTime: dto.maxPlayTime,
      },
    });

    this.eventEmitter.emit(
      GameAddedToEventEvent.eventName,
      new GameAddedToEventEvent(this.toEventGameSnapshot(eventGame), eventId, attendeeId, initiatedAt),
    );

    return eventGame;
  }

  private async elevateToEventGame(nominationId: string, eventId: string, occurrenceId?: string): Promise<EventGame> {
    const initiatedAt = new Date();
    const nomination = await this.db.eventGameNomination.findUniqueOrThrow({
      where: { id: nominationId },
      select: { platformGameId: true, suppliedFromId: true, nominatedById: true },
    });

    const eventGame = await this.db.eventGame.create({
      data: {
        event: occurrenceId ? undefined : { connect: { id: eventId } },
        occurrence: occurrenceId ? { connect: { id: occurrenceId } } : undefined,
        platformGame: { connect: { id: nomination.platformGameId } },
        suppliedBy: { connect: { id: nomination.suppliedFromId } },
        nomination: { connect: { id: nominationId } },
        role: ScheduledGameRole.Primary,
      },
    });

    this.eventEmitter.emit(
      GameAddedToEventEvent.eventName,
      new GameAddedToEventEvent(this.toEventGameSnapshot(eventGame), eventId, nomination.nominatedById, initiatedAt),
    );

    return eventGame;
  }

  /** Scalar snapshot of a created EventGame row for {@link GameAddedToEventEvent}. */
  private toEventGameSnapshot(eventGame: EventGame): GameAddedToEventEvent['after'] {
    return {
      id: eventGame.id,
      eventId: eventGame.eventId,
      occurrenceId: eventGame.occurrenceId,
      platformGameId: eventGame.platformGameId,
      suppliedById: eventGame.suppliedById,
      nominationId: eventGame.nominationId,
      addedById: eventGame.addedById,
      role: eventGame.role,
    };
  }

  private async getEffectivePolicy(
    eventId: string,
    occurrenceId?: string,
  ): Promise<VotingPolicy & { gameAdditionMode: GameAdditionMode; votingWindowHours: number | null }> {
    const eventPolicy = await this.db.eventPolicy.findUnique({
      where: { eventId },
    });

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

  private async getEventAttendees(eventId: string): Promise<AttendeeStub[]> {
    return this.db.eventAttendee.findMany({
      where: { eventId },
      select: {
        status: true,
        availableGames: { select: { id: true } },
      },
    });
  }
}

const NOMINATION_INCLUDE = {
  platformGame: {
    select: {
      id: true,
      game: { select: { id: true, title: true, thumbnail: true } },
      platform: { select: { id: true, name: true, platformType: true } },
    },
  },
  nominatedBy: {
    select: {
      id: true,
      user: { select: { id: true, username: true } },
    },
  },
  suppliedFrom: {
    select: {
      id: true,
      collection: {
        select: {
          platformGame: {
            select: {
              id: true,
              game: { select: { id: true, title: true } },
              platform: { select: { id: true, name: true } },
            },
          },
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
