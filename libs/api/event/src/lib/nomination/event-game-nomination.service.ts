import {
  Action,
  DatabaseService,
  EventGame,
  EventGameVote,
  EventOccurrence,
  EventOccurrencePolicy,
  EventParticipationStatus,
  EventPolicy,
  GameAdditionMode,
  InterestedWeight,
  isPrismaDependentRecordNotFoundError,
  NominationStatus,
  Prisma,
  ResourceType,
  ScheduledGameRole,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { lockSupplier, type LockedSupplier } from '../attendee/attendance';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import { PLATFORM_GAME_SUMMARY_SELECT } from '../constants/platform-game-summary.constant';
import { CastVoteDto } from '../dto/cast-vote.dto';
import { assertEventExists, requireEvent, resolveActingAttendeeId } from '../event-access.helpers';
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
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of an event's nominations plus the total for the response envelope.
   *
   * Unpaginated until #372: it returned every nomination on the event. Unlike
   * occurrences, this list has no natural ceiling at all — it grows with the
   * attendees, and each nomination accumulates votes — so paging it is the
   * point rather than a formality (#372). The response is a truncating
   * change, which pre-alpha allows without a shim.
   *
   * `id` breaks ties on `createdAt`: nominations created in one transaction
   * share a timestamp, and a tie-less sort lets them drift across page
   * boundaries between requests.
   *
   * The existence probe runs ahead of the read, so an event that does not exist
   * is a 404 rather than an empty page — with the same caveat as the occurrence
   * list: it is a separate statement, so an event deleted between the probe and
   * the read answers 200 with an empty page. That is a check-then-act window,
   * not the rows-versus-count split the transaction below closes.
   *
   * The scope is the path's event, composed with the caller's ceiling (#512).
   */
  async getNominations(eventId: string, pagination: PaginationQueryDto): Promise<PaginatedRows<NominationDetail>> {
    await assertEventExists(this.db, eventId);

    const where = this.scopeComposer.compose(ResourceType.EventGameNomination, Action.read, { eventId });

    const [rows, total] = await this.db.$transaction(
      [
        this.db.eventGameNomination.findMany({
          where,
          include: NOMINATION_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.eventGameNomination.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: await this.withVoteEligibility(eventId, rows), total };
  }

  async getNomination(eventId: string, nominationId: string): Promise<NominationDetail> {
    await assertEventExists(this.db, eventId);

    const nomination = await this.db.eventGameNomination.findUnique({
      where: {
        id: nominationId,
        eventId,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGameNomination, Action.read),
      },
      include: NOMINATION_INCLUDE,
    });

    assert(nomination, new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId })));
    return this.withVoteEligibilityOf(eventId, nomination);
  }

  async nominate(eventId: string, dto: NominateGameDto): Promise<NominationDetail> {
    const initiatedAt = new Date();
    const event = await requireEvent(this.db, eventId);

    // An occurrence named in the body has to be one of this event's: the
    // effective policy is read through it, and a Direct-mode nomination is
    // elevated to an EventGame under it, so an occurrence of another event
    // would gate this create by that event's policy and write into it.
    if (dto.occurrenceId) {
      await this.requireOccurrence(eventId, dto.occurrenceId);
    }

    // The route's policy check judges a create by type alone; bind it to the
    // row about to be written — the event in the path, and that event's
    // household for the household-bound grants.
    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.EventGameNomination, {
      eventId,
      event: { householdId: event.householdId },
    });

    const attendeeId = await resolveActingAttendeeId(this.db, this.abilityService, eventId);
    const policy = await this.getEffectivePolicy(eventId, dto.occurrenceId);

    if (policy.gameAdditionMode === GameAdditionMode.HostOnly) {
      throw new ForbiddenException(t('errors.nomination.host_only'));
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

    // A Direct-mode nomination's game joins the lineup in the same
    // transaction, so the supplier the lock vouched for is the one the lineup
    // names.
    const { nomination, elevated } = await this.db.$transaction(async (tx) => {
      await this.assertCanSupply(tx, eventId, dto.suppliedFromId, dto.platformGameId);

      const nomination = await tx.eventGameNomination.create({
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

      const elevated =
        policy.gameAdditionMode === GameAdditionMode.Direct
          ? await this.elevateToEventGame(tx, nomination, eventId, dto.occurrenceId)
          : null;

      return { nomination, elevated };
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

    if (elevated) {
      this.emitGameAdded(elevated, eventId, nomination.nominatedById);
    }

    return this.withVoteEligibilityOf(eventId, nomination, policy.voteEligibility);
  }

  async withdraw(eventId: string, nominationId: string): Promise<NominationDetail> {
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

    // A paused nomination is still the nominator's to pull, whoever supplies
    // it. Otherwise a game whose supplier left could not come off their list
    // until they came back (#551).
    const withdrawable: NominationStatus[] = [
      NominationStatus.Open,
      NominationStatus.AwaitingApproval,
      NominationStatus.Paused,
    ];
    assert(
      withdrawable.includes(nomination.status),
      new BadRequestException(t('errors.nomination.cannot_withdraw_status', { status: nomination.status })),
    );

    try {
      const updated = await this.db.eventGameNomination.update({
        where: {
          id: nominationId,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGameNomination, Action.update),
        },
        data: { status: NominationStatus.Withdrawn, pausedFrom: null },
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

      return this.withVoteEligibilityOf(eventId, updated);
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

    // The route's policy check judges the vote by type alone, and an event
    // role is rendered once per attendance, so a vote grant from any event the
    // actor attends passes it. Bind it to the vote about to be written: the
    // actor's attendee row in this event.
    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.EventGameVote, {
      eventGameNominationId: nominationId,
      attendeeId,
      attendee: { userId: this.abilityService.getActingUserId(), eventId },
    });

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
      const { vote, existingVote } = await this.db.$transaction(async (tx) => {
        // A nomination pauses when its supplier leaves, in the leaving
        // transaction (#551), and a paused nomination takes no votes. The
        // check above can be overtaken; under the share lock, a vote waits for
        // that transaction and then sees the pause.
        const [current] = await tx.$queryRaw<{ status: NominationStatus }[]>(Prisma.sql`
          SELECT status FROM event_game_nominations WHERE id = ${nominationId} FOR SHARE
        `);

        if (current?.status !== NominationStatus.Open) {
          throw new BadRequestException(
            t('errors.nomination.cannot_vote_status', { status: current?.status ?? nomination.status }),
          );
        }

        // Pre-read classifies create vs update for the audit before-snapshot.
        // Best-effort: the unique (nomination, attendee) key means only the
        // same attendee can race this row (double-submit / retry), and in that
        // narrow window the event may label a re-vote as a create or carry a
        // slightly stale before. The upsert itself is always correct.
        const existingVote = await tx.eventGameVote.findUnique({
          where: {
            eventGameNominationId_attendeeId: {
              eventGameNominationId: nominationId,
              attendeeId,
            },
          },
          select: { id: true, voteType: true, priority: true, comment: true },
        });

        const vote = await tx.eventGameVote.upsert({
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

        return { vote, existingVote };
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
      // The re-check's refusal, as the first check would have given it.
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(`Failed to cast vote for nomination ${nominationId} in event ${eventId}: ${error}`, {
        error,
      });

      throw new BadRequestException(t('errors.nomination.vote_failed'));
    }
  }

  async resolveNomination(
    eventId: string,
    nominationId: string,
  ): Promise<{ nomination: NominationDetail; resolution: ResolutionResult }> {
    const initiatedAt = new Date();
    const nomination = await this.db.eventGameNomination.findUnique({
      where: { id: nominationId, eventId },
      select: {
        id: true,
        status: true,
        platformGameId: true,
        occurrenceId: true,
        suppliedFromId: true,
        votes: { select: { voteType: true, attendee: { select: VOTER_SELECT } } },
      },
    });

    assert(nomination, new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId })));
    assert(
      nomination.status === NominationStatus.Open,
      new BadRequestException(t('errors.nomination.cannot_resolve_status', { status: nomination.status })),
    );

    const policy = await this.getEffectivePolicy(eventId, nomination.occurrenceId ?? undefined);
    const attendees = await this.getEventAttendees(eventId);

    const resolution = VoteResolver.resolve(
      nomination.votes.map(({ voteType, attendee }) => ({ voteType, voter: attendee })),
      policy,
      attendees,
    );
    const resolvedStatus = resolution.thresholdMet ? NominationStatus.Passed : NominationStatus.Failed;

    try {
      const { updated, elevated } = await this.settle(eventId, nomination, NominationStatus.Open, resolvedStatus);

      this.eventEmitter.emit(
        NominationResolvedEvent.eventName,
        new NominationResolvedEvent(
          { id: nominationId, eventId, platformGameId: nomination.platformGameId, status: nomination.status },
          { id: updated.id, eventId: updated.eventId, platformGameId: updated.platformGameId, status: updated.status },
          elevated?.eventGame.id ?? null,
          initiatedAt,
        ),
      );

      if (elevated) {
        this.emitGameAdded(elevated, eventId, updated.nominatedById);
      }

      return {
        nomination: await this.withVoteEligibilityOf(eventId, updated, policy.voteEligibility),
        resolution: { ...resolution, status: resolvedStatus },
      };
    } catch (error) {
      this.logger.error(`Error resolving nomination ${nominationId} for event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('errors.nomination.forbidden_resolve'));
      }
      throw error;
    }
  }

  hostApprove(eventId: string, nominationId: string): Promise<NominationDetail> {
    return this.handleHostDecision(eventId, nominationId, NominationStatus.Approved);
  }

  hostReject(eventId: string, nominationId: string): Promise<NominationDetail> {
    return this.handleHostDecision(eventId, nominationId, NominationStatus.Rejected);
  }

  private async handleHostDecision(
    eventId: string,
    nominationId: string,
    decision: NominationStatus,
  ): Promise<NominationDetail> {
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
        suppliedFromId: true,
      },
    });

    assert(nomination, new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId })));
    assert(
      nomination.status === NominationStatus.AwaitingApproval,
      new BadRequestException(t('errors.nomination.cannot_decide_status', { status: nomination.status })),
    );

    try {
      const { updated, elevated } = await this.settle(eventId, nomination, NominationStatus.AwaitingApproval, decision);

      this.eventEmitter.emit(
        NominationResolvedEvent.eventName,
        new NominationResolvedEvent(
          { id: nominationId, eventId, platformGameId: nomination.platformGameId, status: nomination.status },
          { id: updated.id, eventId: updated.eventId, platformGameId: updated.platformGameId, status: updated.status },
          elevated?.eventGame.id ?? null,
          initiatedAt,
        ),
      );

      if (elevated) {
        this.emitGameAdded(elevated, eventId, updated.nominatedById);
      }

      return this.withVoteEligibilityOf(eventId, updated);
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
    const event = await requireEvent(this.db, eventId);

    // An occurrence-level game carries no eventId of its own: its event is the
    // occurrence's. Resolve the occurrence within the event first, so the
    // subject checked below describes the row that will be written rather
    // than the event the request named, and an occurrence of some other event
    // is not found here.
    const occurrence = dto.occurrenceId ? await this.requireOccurrence(eventId, dto.occurrenceId) : null;

    // The route's policy check judges a create by type alone; bind it to the
    // row about to be written, on whichever of its two parents it hangs off.
    this.abilityService.assertCurrentActorCan(
      Action.create,
      ResourceType.EventGame,
      occurrence
        ? {
            eventId: null,
            occurrenceId: occurrence.id,
            event: null,
            occurrence: { id: occurrence.id, eventId, event: { householdId: event.householdId } },
          }
        : { eventId, occurrenceId: null, event: { householdId: event.householdId }, occurrence: null },
    );

    const attendeeId = await resolveActingAttendeeId(this.db, this.abilityService, eventId);
    const policy = await this.getEffectivePolicy(eventId, dto.occurrenceId);

    if (policy.gameAdditionMode !== GameAdditionMode.Direct && policy.gameAdditionMode !== GameAdditionMode.HostOnly) {
      throw new ForbiddenException(t('errors.nomination.direct_add_not_permitted', { mode: policy.gameAdditionMode }));
    }

    const eventGame = await this.db.$transaction(async (tx) => {
      await this.assertCanSupply(tx, eventId, dto.suppliedById, dto.platformGameId);

      return tx.eventGame.create({
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
    });

    this.eventEmitter.emit(
      GameAddedToEventEvent.eventName,
      new GameAddedToEventEvent(this.toEventGameSnapshot(eventGame), eventId, attendeeId, initiatedAt),
    );

    return eventGame;
  }

  /**
   * Writes the EventGame a nomination becomes. The actor is not checked for
   * `create:event_game` here, on purpose: elevation is the outcome of the
   * nomination workflow, not a create request. The event's policy elevates a
   * Direct-mode nomination the moment it is made, and a resolved or approved
   * vote elevates through the `update:event_game_nomination:*` grants, which
   * EventModerator holds without `create:event_game`. The gates are the
   * nomination grants the callers check; `directAddGame` is the create
   * request and carries the EventGame check itself. An occurrence named here
   * has already been resolved within this event by the caller, and the
   * caller's transaction holds the supplier's lock (`assertCanSupply`).
   *
   * The write's own clock, for {@link emitGameAdded}: adding the game to the
   * lineup is a step of its own, after the nomination's.
   */
  private async elevateToEventGame(
    tx: Prisma.TransactionClient,
    nomination: Pick<NominationRow, 'id' | 'platformGameId' | 'suppliedFromId'>,
    eventId: string,
    occurrenceId?: string,
  ): Promise<LineupAddition> {
    const initiatedAt = new Date();
    const eventGame = await tx.eventGame.create({
      data: {
        event: occurrenceId ? undefined : { connect: { id: eventId } },
        occurrence: occurrenceId ? { connect: { id: occurrenceId } } : undefined,
        platformGame: { connect: { id: nomination.platformGameId } },
        suppliedBy: { connect: { id: nomination.suppliedFromId } },
        nomination: { connect: { id: nomination.id } },
        role: ScheduledGameRole.Primary,
      },
    });

    return { eventGame, initiatedAt };
  }

  /** Emits the {@link GameAddedToEventEvent} for a nomination's game added to the lineup, once its transaction has committed. */
  private emitGameAdded(elevated: LineupAddition, eventId: string, nominatedById: string): void {
    this.eventEmitter.emit(
      GameAddedToEventEvent.eventName,
      new GameAddedToEventEvent(
        this.toEventGameSnapshot(elevated.eventGame),
        eventId,
        nominatedById,
        elevated.initiatedAt,
      ),
    );
  }

  /**
   * Moves a nomination from `expected` to its outcome, adding its game to the
   * lineup when the outcome passes it.
   *
   * The status was checked before the votes were counted, and a nomination
   * can pause in between: its supplier leaving the event pauses it in the
   * leaving transaction (#551). So the supplier is locked first, the order
   * the leaving transaction takes them in, then the nomination is locked and
   * checked again. One that has since paused, or been withdrawn, answers as
   * the first check would have.
   */
  private async settle(
    eventId: string,
    nomination: Pick<NominationRow, 'id' | 'platformGameId' | 'suppliedFromId' | 'occurrenceId'>,
    expected: NominationStatus,
    outcome: NominationStatus,
  ): Promise<{ updated: NominationRow; elevated: LineupAddition | null }> {
    const elevates = outcome === NominationStatus.Passed || outcome === NominationStatus.Approved;

    return this.db.$transaction(async (tx) => {
      const supplier = await lockSupplier(tx, nomination.suppliedFromId);
      const [current] = await tx.$queryRaw<{ status: NominationStatus }[]>(Prisma.sql`
        SELECT status FROM event_game_nominations WHERE id = ${nomination.id} FOR UPDATE
      `);

      if (current?.status !== expected) {
        const status = current?.status ?? expected;
        throw new BadRequestException(
          expected === NominationStatus.Open
            ? t('errors.nomination.cannot_resolve_status', { status })
            : t('errors.nomination.cannot_decide_status', { status }),
        );
      }

      if (elevates) {
        this.assertSupplies(supplier, eventId, nomination.suppliedFromId, nomination.platformGameId);
      }

      const updated = await tx.eventGameNomination.update({
        where: {
          id: nomination.id,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGameNomination, Action.update),
        },
        data: { status: outcome },
        include: NOMINATION_INCLUDE,
      });

      const elevated = elevates
        ? await this.elevateToEventGame(tx, nomination, eventId, nomination.occurrenceId ?? undefined)
        : null;

      return { updated, elevated };
    });
  }

  private async requireOccurrence(eventId: string, occurrenceId: string): Promise<Pick<EventOccurrence, 'id'>> {
    const occurrence = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true },
    });

    assert(occurrence, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));
    return occurrence;
  }

  /**
   * {@link assertSupplies}, on the entry as {@link lockSupplier} reads and
   * locks it, so the answer holds until the caller's transaction commits.
   */
  private async assertCanSupply(
    tx: Prisma.TransactionClient,
    eventId: string,
    gameListId: string,
    platformGameId: string,
  ): Promise<void> {
    this.assertSupplies(await lockSupplier(tx, gameListId), eventId, gameListId, platformGameId);
  }

  /**
   * What makes a game-list entry a valid supplier, for a nomination, a direct
   * add and a nomination's game joining the lineup alike:
   *
   * - It belongs to an attendee of this event, and neither the entry nor the
   *   attendee was removed. Otherwise it is not found, as any row outside the
   *   event is: this keeps a write in one event from naming another event's
   *   attendee as bringing the game.
   * - It is for the game being added, so no one is recorded as bringing a
   *   game their entry is not for.
   * - Its attendee is attending, or may be (#551). Someone who is not
   *   attending supplies no game: leaving paused or deleted the ones they
   *   did, and this keeps new ones from taking their place.
   */
  private assertSupplies(
    supplier: LockedSupplier | null,
    eventId: string,
    gameListId: string,
    platformGameId: string,
  ): asserts supplier is LockedSupplier {
    if (supplier?.eventId !== eventId || supplier.attendeeRemovedAt !== null || supplier.entryRemovedAt !== null) {
      throw new NotFoundException(t('errors.nomination.supplier_not_found', { gameListId }));
    }

    if (supplier.platformGameId !== platformGameId) {
      throw new BadRequestException(t('errors.nomination.supplier_mismatch'));
    }

    if (supplier.status === EventParticipationStatus.NotAttending) {
      throw new ConflictException(t('errors.nomination.supplier_not_attending'));
    }
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

  private async getEffectivePolicy(eventId: string, occurrenceId?: string): Promise<EffectivePolicy> {
    const eventPolicy = await this.db.eventPolicy.findUnique({
      where: { eventId },
    });

    const occPolicy = occurrenceId
      ? await this.db.eventOccurrencePolicy.findUnique({
          where: { occurrenceId },
        })
      : null;

    return effectivePolicy(eventPolicy, occPolicy);
  }

  /**
   * Each vote on the nominations, marked with whether it counts: whether its
   * voter is eligible now, under the rule of the nomination's own date or
   * the event's (#551). A vote that does not count is still served, so
   * everyone sees how its voter voted, and that it does not count.
   */
  private async withVoteEligibility(eventId: string, nominations: NominationRow[]): Promise<NominationDetail[]> {
    const occurrenceIds = [
      ...new Set(nominations.flatMap(({ occurrenceId }) => (occurrenceId === null ? [] : [occurrenceId]))),
    ];

    const [eventPolicy, occPolicies] = await Promise.all([
      this.db.eventPolicy.findUnique({ where: { eventId } }),
      occurrenceIds.length > 0
        ? this.db.eventOccurrencePolicy.findMany({ where: { occurrenceId: { in: occurrenceIds } } })
        : [],
    ]);

    const occPolicyById = new Map(occPolicies.map((occPolicy) => [occPolicy.occurrenceId, occPolicy]));

    return nominations.map((nomination) => {
      const occPolicy = nomination.occurrenceId === null ? null : (occPolicyById.get(nomination.occurrenceId) ?? null);
      return markVotes(nomination, effectivePolicy(eventPolicy, occPolicy).voteEligibility);
    });
  }

  /**
   * {@link withVoteEligibility} for one nomination. A caller already holding
   * the nomination's policy passes its eligibility rule, and nothing is read.
   */
  private async withVoteEligibilityOf(
    eventId: string,
    nomination: NominationRow,
    voteEligibility?: VoteEligibility,
  ): Promise<NominationDetail> {
    if (voteEligibility !== undefined) {
      return markVotes(nomination, voteEligibility);
    }

    const [detail] = await this.withVoteEligibility(eventId, [nomination]);
    return detail;
  }

  /** The event's attendees, as the resolver counts its pool. Removed attendees are no part of it. */
  private async getEventAttendees(eventId: string): Promise<AttendeeStub[]> {
    return this.db.eventAttendee.findMany({
      where: { eventId, ...NOT_REMOVED },
      select: VOTER_SELECT,
    });
  }
}

type EffectivePolicy = VotingPolicy & { gameAdditionMode: GameAdditionMode; votingWindowHours: number | null };

/** A nomination's game added to the lineup, with the clock its domain event carries. */
interface LineupAddition {
  eventGame: EventGame;
  initiatedAt: Date;
}

/** A nomination with each vote marked with whether it counts under the rule given, its voter's state dropped. */
function markVotes({ votes, ...nomination }: NominationRow, voteEligibility: VoteEligibility): NominationDetail {
  return {
    ...nomination,
    votes: votes.map(({ attendee, ...vote }) => ({
      ...vote,
      eligible: VoteResolver.isEligibleVoter(attendee, voteEligibility),
    })),
  };
}

/** The policy a nomination is held to: its date's, where the date sets a field, else the event's. */
function effectivePolicy(eventPolicy: EventPolicy | null, occPolicy: EventOccurrencePolicy | null): EffectivePolicy {
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

/**
 * What decides whether a voter's vote counts (`VoteResolver.isEligibleVoter`).
 * One entry on their list is enough to tell whether they offer games, so no
 * more are read.
 */
const VOTER_SELECT = {
  status: true,
  removedAt: true,
  availableGames: { where: NOT_REMOVED, select: { id: true }, take: 1 },
} as const satisfies Prisma.EventAttendeeSelect;

const NOMINATION_INCLUDE = {
  platformGame: { select: PLATFORM_GAME_SUMMARY_SELECT },
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
  // Unbounded: every vote of every nomination on the page. #372 capped the
  // outer list; capping or aggregating this is #404, because it changes what the
  // endpoint serves rather than how it wraps it.
  votes: {
    select: {
      id: true,
      attendeeId: true,
      voteType: true,
      priority: true,
      comment: true,
      // Read to mark the vote, then dropped (`withVoteEligibility`).
      attendee: { select: VOTER_SELECT },
    },
  },
} as const satisfies Prisma.EventGameNominationInclude;

type NominationRow = Prisma.EventGameNominationGetPayload<{ include: typeof NOMINATION_INCLUDE }>;

/** A nomination as every route serves it: each vote marked with whether it counts (#551). */
export type NominationDetail = Omit<NominationRow, 'votes'> & {
  votes: (Omit<NominationRow['votes'][number], 'attendee'> & { eligible: boolean })[];
};
