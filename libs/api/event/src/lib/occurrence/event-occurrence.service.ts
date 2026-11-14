import {
  Action,
  AvailabilityResponse,
  DatabaseService,
  EventAvailabilityVote,
  EventParticipationStatus,
  EventSchedulingMode,
  isPrismaDependentRecordNotFoundError,
  OccurrenceStatus,
  Prisma,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { emitRemovedGames, writeEventDates } from '../attendee/attendance';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import { OCCURRENCE_ORDER } from '../constants/occurrence-order.constant';
import { PLATFORM_GAME_SUMMARY_SELECT } from '../constants/platform-game-summary.constant';
import { assertEventExists, resolveActingAttendeeId } from '../event-access.helpers';
import { assertEventNotCancelled } from '../lifecycle/event-lifecycle.helpers';
import { canReadEventPolicy, eventPolicyReadArgs, serveOccurrencePolicy } from '../policy/policy-ceiling';
import { POLICY_VIEW_INCLUDE, type OccurrencePolicyView } from '../policy/policy-view';
import { changedKeys, pickSnapshot } from '../utils/pick-snapshot.util';
import { AVAILABILITY_VOTE_SLUG, countsAsVoter, voterGrantSelect } from '../vote/vote-grant';
import { OccurrenceEvents } from './constants';
import { AddOccurrenceDto } from './dto/add-occurrence.dto';
import { SubmitAvailabilityDto } from './dto/submit-availability.dto';
import { UpdateEventOccurrenceDto } from './dto/update-event-occurrence.dto';
import {
  AvailabilityVoteSubmittedEvent,
  OccurrenceAddedEvent,
  OccurrenceRemovedEvent,
  OccurrenceStatusChangedEvent,
  OccurrenceUpdatedEvent,
} from './events/occurrence.events';
import type { AvailabilitySummary, AvailabilitySummaryEntry } from './interfaces';

@Injectable()
export class EventOccurrenceService {
  private readonly logger = new Logger(EventOccurrenceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of an event's occurrences plus the total for the response envelope.
   *
   * This read was unpaginated until #372 — it returned every occurrence of the
   * event, however many that was. A nested list is a tempting exception ("an
   * event has a handful of dates"), but nothing in the schema bounds it, and an
   * unbounded list read is the #11 self-DoS with a smaller number in front of
   * it. #372 paginates it; the response is a truncating change, which
   * pre-alpha allows without a shim.
   *
   * `id` breaks ties on `sortOrder`, which is an `Int @default(0)` and so shares
   * a value across every occurrence nobody has reordered. Without the
   * tie-breaker those rows drift across page boundaries between requests — page
   * 2 repeating a date page 1 already showed, and dropping another.
   *
   * The existence probe runs ahead of the read, so an event that does not exist
   * is a 404 rather than an empty page. It is deliberately NOT inside the
   * transaction below: pulling it in would mean an interactive transaction, and
   * holding a pooled connection and an open snapshot across the probe to spare
   * a check-then-act window is the wrong trade for a read. The window is real
   * and bounded — a soft delete keeps the occurrence rows, so an event deleted
   * between the probe and the read answers 200 with them rather than 404 — and
   * it is the ordinary TOCTOU any probe-then-read has. It says nothing about the
   * rows and count, which do share one snapshot.
   *
   * The scope is the path's event, composed with the caller's ceiling (#512).
   * Each occurrence's votes and games come from reads of their own, after the
   * page: see {@link withVotesAndGames}.
   */
  async getOccurrences(eventId: string, pagination: PaginationQueryDto): Promise<PaginatedRows<OccurrenceDetail>> {
    await assertEventExists(this.db, eventId);

    const where = this.scopeComposer.compose(ResourceType.EventOccurrence, Action.read, { eventId });

    // The policy's ceiling is read in the same snapshot as the page it gates.
    const [occurrences, total, policiesReadable] = await this.db.$transaction(
      [
        this.db.eventOccurrence.findMany({
          where,
          include: { policy: { include: POLICY_VIEW_INCLUDE } },
          orderBy: OCCURRENCE_ORDER,
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.eventOccurrence.count({ where }),

        this.db.eventPolicy.count({ where: eventPolicyReadArgs(this.abilityService, eventId).where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const canReadPolicy = policiesReadable > 0;

    return {
      rows: await this.withVotesAndGames(
        occurrences.map((occurrence) => ({
          ...occurrence,
          policy: serveOccurrencePolicy(occurrence.policy, canReadPolicy),
        })),
      ),
      total,
    };
  }

  async getOccurrence(eventId: string, occurrenceId: string): Promise<OccurrenceDetail> {
    await assertEventExists(this.db, eventId);

    const occurrence = await this.db.eventOccurrence.findUnique({
      where: {
        id: occurrenceId,
        eventId,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.read),
      },
      include: { policy: { include: POLICY_VIEW_INCLUDE } },
    });

    assert(occurrence, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

    const canReadPolicy = await canReadEventPolicy(this.db, this.abilityService, eventId);

    const [detail] = await this.withVotesAndGames([
      { ...occurrence, policy: serveOccurrencePolicy(occurrence.policy, canReadPolicy) },
    ]);
    return detail;
  }

  /**
   * The occurrences, each with its availability votes and games, read under
   * the votes' and the games' own ceilings (#560). Every occurrence route
   * answers through here, the writes as well as the reads, but the create:
   * a new occurrence has neither.
   *
   * Reading an occurrence, or writing one, is not reading its votes or its
   * games. A friend of the host, or a household guest, reads the event's
   * occurrences but neither of the other two: each vote names the attendee
   * who cast it, and the user behind them, which is who attends the event.
   * Every catalog role that writes an occurrence reads both, but an API key or
   * a plugin can hold the write alone. Embedded in the occurrence, both went
   * to whoever could read or write it. Clipping them inside the `include`
   * would fail open (#559), so each is its own read with its ceiling in the
   * top-level `where`, and is matched to its occurrence here. A caller with no
   * read on votes or games gets `[]` for them.
   *
   * A read route reads them after its occurrences, outside the page's
   * snapshot, since which occurrences to read them for is that read's answer.
   * A vote cast in between can appear; it is one on an occurrence the caller
   * was served. A write reads them before its statement, since the id is in
   * the path. Read after the commit, a failed read would report a write that
   * happened as one that didn't, and a retried update would emit its event,
   * and so write its audit row, a second time.
   *
   * Unbounded, as the embed was: every vote and game on every occurrence
   * given. The page size caps the occurrences, not their votes (#404).
   */
  private async withVotesAndGames<TOccurrence extends { id: string }>(
    occurrences: TOccurrence[],
  ): Promise<(TOccurrence & VotesAndGames)[]> {
    if (occurrences.length === 0) {
      return [];
    }

    const occurrenceId = { in: occurrences.map((occurrence) => occurrence.id) };

    const [votes, games] = await Promise.all([
      this.db.eventAvailabilityVote.findMany({
        where: this.scopeComposer.compose(ResourceType.EventAvailabilityVote, Action.read, { occurrenceId }),
        select: { ...OCCURRENCE_VOTE_SELECT, occurrenceId: true },
        orderBy: OCCURRENCE_VOTE_ORDER,
      }),
      this.db.eventGame.findMany({
        where: this.scopeComposer.compose(ResourceType.EventGame, Action.read, { occurrenceId }),
        select: { ...OCCURRENCE_GAME_SELECT, occurrenceId: true },
        orderBy: OCCURRENCE_GAME_ORDER,
      }),
    ]);

    const votesByOccurrence = groupByOccurrence(votes.map(toOccurrenceVote));
    const gamesByOccurrence = groupByOccurrence(games);

    return occurrences.map((occurrence) => ({
      ...occurrence,
      availabilityVotes: votesByOccurrence.get(occurrence.id) ?? [],
      games: gamesByOccurrence.get(occurrence.id) ?? [],
    }));
  }

  async addOccurrence(eventId: string, dto: AddOccurrenceDto): Promise<OccurrenceDetail> {
    const initiatedAt = new Date();
    const event = await this.db.event.findUnique({
      where: { id: eventId, deletedAt: null },
      select: { id: true, householdId: true },
    });

    assert(event, new NotFoundException(t('errors.event.not_found', { id: eventId })));

    // The route's policy check judges a create by type alone; bind it to the
    // row about to be written — the event in the path, and that event's
    // household for the household-bound grants.
    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.EventOccurrence, {
      eventId,
      event: { householdId: event.householdId },
    });

    const { written: occurrence, removedGames } = await this.db.$transaction((tx) =>
      writeEventDates(tx, eventId, initiatedAt, async () => {
        // A cancelled event takes no new date (#795). Read under the date
        // write's lock, which a cancel also takes.
        await assertEventNotCancelled(tx, eventId);

        // The mode read before the lock is only good for the 404 and the
        // permission check. A PATCH that switches the event to Fixed holds
        // the same lock, so the mode is read again here, or a date could be
        // added to an event that just became Fixed with one date already (#796).
        const locked = await tx.event.findUnique({
          where: { id: eventId, deletedAt: null },
          select: { schedulingMode: true },
        });
        assert(locked, new NotFoundException(t('errors.event.not_found', { id: eventId })));

        if (locked.schedulingMode === EventSchedulingMode.Fixed) {
          // Every date counts here, declined and cancelled ones too. Counting
          // only live dates is #966's change.
          const existingCount = await tx.eventOccurrence.count({ where: { eventId } });

          if (existingCount >= 1) {
            throw new BadRequestException(t('errors.occurrence.fixed_mode_single'));
          }
        }

        const status =
          dto.status ??
          (locked.schedulingMode === EventSchedulingMode.Poll ? OccurrenceStatus.Proposed : OccurrenceStatus.Confirmed);

        return tx.eventOccurrence.create({
          data: {
            event: { connect: { id: eventId } },
            label: dto.label,
            startDate: dto.startDate,
            endDate: dto.endDate,
            location: dto.location,
            status,
            sortOrder: dto.sortOrder ?? 0,
          },
        });
      }),
    );

    this.eventEmitter.emit(
      OccurrenceAddedEvent.eventName,
      new OccurrenceAddedEvent(
        {
          id: occurrence.id,
          eventId: occurrence.eventId,
          label: occurrence.label,
          startDate: occurrence.startDate,
          endDate: occurrence.endDate,
          location: occurrence.location,
          status: occurrence.status,
          sortOrder: occurrence.sortOrder,
        },
        initiatedAt,
      ),
    );
    emitRemovedGames(this.eventEmitter, eventId, removedGames, initiatedAt);

    // A new occurrence has no votes or games yet, so it answers with none
    // rather than reading for them. That read would run after the row has
    // committed, and if it failed, a create that happened would be reported
    // as one that didn't, inviting a retry that adds the occurrence twice.
    //
    // It has no policy row either, so the policy is `null` without a ceiling
    // read (#1211).
    return { ...occurrence, policy: null, availabilityVotes: [], games: [] };
  }

  async updateOccurrence(
    eventId: string,
    occurrenceId: string,
    dto: UpdateEventOccurrenceDto,
  ): Promise<OccurrenceDetail> {
    const initiatedAt = new Date();
    assert(Object.keys(dto).length > 0, new BadRequestException(t('common.at_least_one_field')));

    // Only the id: this read answers 404 and names the date whose votes and
    // games are read next. What the write replaces is read under the lock.
    const found = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true },
    });

    assert(found, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

    // Read before the write, so a failed read leaves the occurrence as it was.
    // The write can take games off the lineup, and the answer leaves those out.
    const [{ availabilityVotes, games }] = await this.withVotesAndGames([found]);

    try {
      const {
        written: { existing, updated, canReadPolicy },
        removedGames,
      } = await this.db.$transaction((tx) =>
        writeEventDates(tx, eventId, initiatedAt, async () => {
          // Read again under the event's lock, which a removal also holds. An
          // edit that lost a race to the date's removal answers 404, as one
          // arriving second would. A removal can't be undone, so a failed
          // update after this read is the grant refusing the edit (#1064).
          // The whole row, since it is the state the write replaces, and the
          // audit is judged against it, even when another write to the date
          // went first (#728).
          const existing = await tx.eventOccurrence.findUnique({
            where: { id: occurrenceId, eventId },
          });
          assert(existing, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

          // Under the lock, so the answer and the policy it serves come from
          // the same state: an event made private meanwhile is read as it now
          // is (#1211).
          const canReadPolicy = await canReadEventPolicy(tx, this.abilityService, eventId);

          const updated = await tx.eventOccurrence.update({
            where: {
              id: occurrenceId,
              // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
              AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.update),
            },
            data: {
              label: dto.label,
              startDate: dto.startDate,
              endDate: dto.endDate,
              location: dto.location,
              sortOrder: dto.sortOrder,
            },
            include: { policy: { include: POLICY_VIEW_INCLUDE } },
          });

          return { existing, updated, canReadPolicy };
        }),
      );

      // Only the columns whose values changed are audited; a patch that
      // re-sends stored values emits nothing (#728).
      const changed = changedKeys(existing, updated, ['label', 'startDate', 'endDate', 'location', 'sortOrder']);
      if (changed.length > 0) {
        this.eventEmitter.emit(
          OccurrenceUpdatedEvent.eventName,
          new OccurrenceUpdatedEvent(pickSnapshot(existing, changed), pickSnapshot(updated, changed), initiatedAt),
        );
      }
      emitRemovedGames(this.eventEmitter, eventId, removedGames, initiatedAt);

      const removedIds = new Set(removedGames.map((game) => game.id));
      return {
        ...updated,
        policy: serveOccurrencePolicy(updated.policy, canReadPolicy),
        availabilityVotes,
        games: games.filter((game) => !removedIds.has(game.id)),
      };
    } catch (error) {
      this.logger.error(`Error updating occurrence ${occurrenceId} for event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }
      throw error;
    }
  }

  async removeOccurrence(eventId: string, occurrenceId: string): Promise<OccurrenceDetail> {
    const initiatedAt = new Date();
    this.logger.debug(`Attempting to remove occurrence ${occurrenceId} from event ${eventId}`);

    const existing = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true },
    });

    assert(existing, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

    // The votes and games are deleted with the date, so they are read first,
    // only to answer with what was removed. One added between this read and
    // the delete is removed without being listed. Closing that gap would take
    // a lock on the date's row, held in an interactive transaction across both
    // reads and the delete, and this answer is all it would protect: the
    // domain event below carries the date's own columns, not that list (#677).
    const [{ availabilityVotes, games }] = await this.withVotesAndGames([existing]);

    try {
      const {
        written: { removed, canReadPolicy },
        removedGames,
      } = await this.db.$transaction((tx) =>
        writeEventDates(tx, eventId, initiatedAt, async () => {
          // eslint-disable-next-line no-restricted-syntax -- single-row delete by id, not a collection read
          const deleteConditions = this.abilityService.getCurrentResourceConditions(
            ResourceType.EventOccurrence,
            Action.delete,
          );

          // Read under the event's lock, which a confirm or another removal
          // also holds, so the status is the one the delete meets. A Confirmed
          // date must be cancelled first, and is refused here, so its attendees
          // are told it is off before it disappears (#677). A removal that lost
          // a race to another removal answers 404, as one arriving second would
          // (#1064).
          const current = await tx.eventOccurrence.findFirst({
            where: { id: occurrenceId, eventId, AND: deleteConditions },
            select: { status: true },
          });

          if (!current) {
            // The grant is checked before the status, so a caller who may not
            // remove the date learns nothing of it: 403, never 400 (#677).
            const present = await tx.eventOccurrence.findFirst({
              where: { id: occurrenceId, eventId },
              select: { id: true },
            });
            assert(present, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));
            throw new ForbiddenException(t('common.forbidden.remove'));
          }

          assert(
            current.status !== OccurrenceStatus.Confirmed,
            new BadRequestException(t('errors.occurrence.confirmed_remove')),
          );

          // Under the lock, as updateOccurrence reads it (#1211).
          const canReadPolicy = await canReadEventPolicy(tx, this.abilityService, eventId);

          const removed = await tx.eventOccurrence.delete({
            where: { id: occurrenceId, AND: deleteConditions },
            include: { policy: { include: POLICY_VIEW_INCLUDE } },
          });

          return { removed, canReadPolicy };
        }),
      );
      // Date first, then its games, so the audit order reads the way it happened.
      this.eventEmitter.emit(
        OccurrenceRemovedEvent.eventName,
        new OccurrenceRemovedEvent(
          {
            id: removed.id,
            eventId: removed.eventId,
            label: removed.label,
            startDate: removed.startDate,
            endDate: removed.endDate,
            status: removed.status,
          },
          initiatedAt,
        ),
      );
      emitRemovedGames(this.eventEmitter, eventId, removedGames, initiatedAt);

      return { ...removed, policy: serveOccurrencePolicy(removed.policy, canReadPolicy), availabilityVotes, games };
    } catch (error) {
      this.logger.error(`Error removing occurrence ${occurrenceId} from event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.remove'));
      }
      throw error;
    }
  }

  /** A cancelled event takes no new Confirmed date: reopen it first (#795). */
  async confirmOccurrence(eventId: string, occurrenceId: string): Promise<OccurrenceDetail> {
    return this.transitionStatus(
      eventId,
      occurrenceId,
      [OccurrenceStatus.Proposed],
      OccurrenceStatus.Confirmed,
      { confirmedAt: new Date() },
      { refuseOnCancelledEvent: true },
    );
  }

  async declineOccurrence(eventId: string, occurrenceId: string): Promise<OccurrenceDetail> {
    return this.transitionStatus(eventId, occurrenceId, [OccurrenceStatus.Proposed], OccurrenceStatus.Declined, {
      declinedAt: new Date(),
    });
  }

  /**
   * Cancels one date, with an optional reason, as cancelling its event
   * writes one on each date (#795). The event itself stays on, however many
   * of its dates are cancelled.
   */
  async cancelOccurrence(eventId: string, occurrenceId: string, reason?: string): Promise<OccurrenceDetail> {
    return this.transitionStatus(eventId, occurrenceId, [OccurrenceStatus.Confirmed], OccurrenceStatus.Cancelled, {
      cancelledAt: new Date(),
      cancelledById: this.abilityService.getActingUserId(),
      cancelReason: reason ?? null,
    });
  }

  /**
   * Moves a date from a status in `allowedFrom` to `newStatus`.
   *
   * The write takes the event's row lock, `FOR NO KEY UPDATE`, as every
   * write to its dates does, the event's cancel included, and reads the
   * date's status again under it. The status read first answers the common
   * case early; the one under the lock is what the write meets. A transition
   * that loses a race answers as one arriving second would: a confirm of a
   * date the event's cancel declined meanwhile answers 400, even once the
   * event is reopened, rather than reviving the date (#795). The write
   * repeats the status it read.
   *
   * With `refuseOnCancelledEvent`, it also reads the event's cancel under
   * the lock ({@link assertEventNotCancelled}), so a confirm on a cancelled
   * event answers 400.
   */
  private async transitionStatus(
    eventId: string,
    occurrenceId: string,
    allowedFrom: OccurrenceStatus[],
    newStatus: OccurrenceStatus,
    extraData: Record<string, unknown> = {},
    { refuseOnCancelledEvent = false }: { refuseOnCancelledEvent?: boolean } = {},
  ): Promise<OccurrenceDetail> {
    const initiatedAt = new Date();
    const actingUserId = resolveActingUserIdOrNull(this.abilityService);
    const readStatus = (client: Prisma.TransactionClient) =>
      client.eventOccurrence.findUnique({
        where: { id: occurrenceId, eventId },
        select: { id: true, status: true },
      });

    const transition = { eventId, occurrenceId, allowedFrom, newStatus };
    const existing = await readStatus(this.db);
    assertTransitionAllowed(existing, transition);

    // Read before the write, which changes neither, so a failed read leaves
    // the occurrence as it was.
    const [{ availabilityVotes, games }] = await this.withVotesAndGames([existing]);

    try {
      const { before, updated, canReadPolicy } = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${eventId} FOR NO KEY UPDATE`);

        if (refuseOnCancelledEvent) {
          await assertEventNotCancelled(tx, eventId);
        }

        const current = await readStatus(tx);
        assertTransitionAllowed(current, transition);

        // Under the lock, as updateOccurrence reads it (#1211).
        const canReadPolicy = await canReadEventPolicy(tx, this.abilityService, eventId);

        const written = await tx.eventOccurrence.update({
          where: {
            id: occurrenceId,
            status: current.status,
            // Status transitions are mutations → filter by `update`, not `read`.
            // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.update),
          },
          data: { status: newStatus, ...extraData },
          include: { policy: { include: POLICY_VIEW_INCLUDE } },
        });

        return { before: current, updated: written, canReadPolicy };
      });

      const domainEvent =
        newStatus === OccurrenceStatus.Confirmed
          ? OccurrenceEvents.OccurrenceConfirmed
          : newStatus === OccurrenceStatus.Declined
            ? OccurrenceEvents.OccurrenceDeclined
            : OccurrenceEvents.OccurrenceCancelled;

      this.eventEmitter.emit(
        domainEvent,
        new OccurrenceStatusChangedEvent(
          { id: occurrenceId, eventId, status: before.status },
          { id: updated.id, eventId: updated.eventId, status: updated.status },
          { occurrenceLabel: updated.label, actingUserId },
          initiatedAt,
        ),
      );

      return { ...updated, policy: serveOccurrencePolicy(updated.policy, canReadPolicy), availabilityVotes, games };
    } catch (error) {
      this.logger.error(`Error transitioning occurrence ${occurrenceId} to ${newStatus}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }

  async submitAvailability(
    eventId: string,
    occurrenceId: string,
    dto: SubmitAvailabilityDto,
  ): Promise<EventAvailabilityVote> {
    const initiatedAt = new Date();
    const attendeeId = await resolveActingAttendeeId(this.db, this.abilityService, eventId);

    // The route's policy check judges the vote by type alone, and an event
    // role is rendered once per attendance, so a vote grant from any event the
    // actor attends passes it. Bind it to the vote about to be written: the
    // actor's attendee row in this event.
    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.EventAvailabilityVote, {
      occurrenceId,
      attendeeId,
      attendee: { userId: this.abilityService.getActingUserId(), eventId },
    });

    const occurrence = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true, status: true },
    });

    if (!occurrence) {
      throw new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId }));
    }

    if (occurrence.status !== OccurrenceStatus.Proposed) {
      throw new BadRequestException(t('errors.occurrence.availability_proposed_only', { status: occurrence.status }));
    }

    // Pre-read classifies create vs update for the audit before-snapshot.
    // Best-effort, not transactional: the unique (occurrence, attendee) key
    // means only the same attendee can race this row (double-submit / retry),
    // and in that narrow window the event may label a re-vote as a create or
    // carry a slightly stale before. The upsert itself is always correct.
    const existingVote = await this.db.eventAvailabilityVote.findUnique({
      where: { occurrenceId_attendeeId: { occurrenceId, attendeeId } },
      select: { id: true, response: true },
    });

    const vote = await this.db.eventAvailabilityVote.upsert({
      where: {
        occurrenceId_attendeeId: { occurrenceId, attendeeId },
      },
      create: {
        occurrence: { connect: { id: occurrenceId } },
        attendee: { connect: { id: attendeeId } },
        response: dto.response,
      },
      update: {
        response: dto.response,
      },
    });

    this.eventEmitter.emit(
      AvailabilityVoteSubmittedEvent.eventName,
      new AvailabilityVoteSubmittedEvent(
        existingVote ? { id: existingVote.id, response: existingVote.response } : null,
        existingVote
          ? { id: vote.id, response: vote.response }
          : { id: vote.id, occurrenceId: vote.occurrenceId, attendeeId: vote.attendeeId, response: vote.response },
        initiatedAt,
      ),
    );

    return vote;
  }

  /**
   * UNBOUNDED, knowingly (#404). Every occurrence of the event, every
   * availability vote on each, and every attendee — the same shape of read
   * `getOccurrences` above was paginated to remove, and on a big event the
   * larger of the two.
   *
   * Not fixed under #372 because paging a SUMMARY makes it wrong rather than
   * partial: the counts below are over the whole event, and half a summary
   * answers a question nobody asked. The fix is an aggregate in the database
   * (`groupBy` on the votes) or a ceiling on occurrences per event, both of
   * which change what this route serves. #404 owns it.
   *
   * Attendees, occurrences and votes each compose the caller's ceiling (#512).
   * The route's guard checks only the type, `can(read, EventAvailabilityVote)`,
   * which every event role passes for any event, so the query is where the
   * path's event meets the caller's own. The attendee half used to AND no
   * ceiling at all, which let an attendee of one event read another event's
   * attendance counts. Each collection now counts only the rows the caller may
   * read, so an event whose attendees or occurrences are outside the caller's
   * ceiling answers zero counts, like the sibling lists' empty page:
   * `assertEventExists` checks only that the event exists. Being able to read
   * the Event row itself reaches none of them. A friend of the host, or a
   * household guest, reads the event's occurrences but not its attendees or
   * votes (#560), so their summary lists each occurrence with zero counts.
   *
   * The votes are read on their own and matched in memory to the attendees
   * and occurrences read beside them, so every ceiling here sits in a
   * top-level `where`. That is the only place `DatabaseService`'s CASL
   * extension turns a deny-all, CASL's `{ OR: [] }`, into no rows. Inside an
   * `include`'s filter, Prisma drops it (prisma#21856), and the votes it was
   * meant to clip all come back.
   *
   * The match also keeps the numbers about the same people. `pendingVotes`
   * and `participationRate` divide votes by `eligibleVoters`, so a vote whose
   * attendee the attendee read did not return is never counted, even one
   * cast between the reads. Every user role binds all three reads to the same
   * event or household; an API key holding a subset of them is the caller
   * this protects.
   */
  async getAvailabilitySummary(eventId: string): Promise<AvailabilitySummary> {
    await assertEventExists(this.db, eventId);

    const [attendees, occurrences, votes] = await Promise.all([
      this.db.eventAttendee.findMany({
        where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, { eventId, ...NOT_REMOVED }),
        select: { id: true, status: true, removedAt: true, ...voterGrantSelect(AVAILABILITY_VOTE_SLUG) },
      }),
      this.db.eventOccurrence.findMany({
        where: this.scopeComposer.compose(ResourceType.EventOccurrence, Action.read, { eventId }),
        orderBy: OCCURRENCE_ORDER,
      }),
      this.db.eventAvailabilityVote.findMany({
        where: this.scopeComposer.compose(ResourceType.EventAvailabilityVote, Action.read, {
          occurrence: { is: { eventId } },
        }),
        select: { occurrenceId: true, attendeeId: true, response: true },
      }),
    ]);

    // An attendee who is not attending keeps their votes, and the summary
    // lists them, marked as not counting; none of the counts includes them
    // (#551). Nor does it count an attendee whose event role can't vote on
    // dates, such as a spectator: their votes are listed the same way (#759).
    // A removed attendee is not read at all.
    const attendeeById = new Map(attendees.map((a) => [a.id, a]));
    const votesByOccurrence = groupByOccurrence(
      votes.flatMap((vote) => {
        const attendee = attendeeById.get(vote.attendeeId);
        return attendee ? [{ ...vote, eligible: countsAsVoter(attendee) }] : [];
      }),
    );

    const registered = attendees.filter((a) => a.userId !== null);
    const guests = attendees.filter((a) => a.userId === null);
    const eligibleVoters = attendees.filter(countsAsVoter).length;

    const byStatus = {
      attending: 0,
      invited: 0,
      maybe: 0,
      notAttending: 0,
    };

    for (const attendee of attendees) {
      switch (attendee.status) {
        case EventParticipationStatus.Attending:
          byStatus.attending++;
          break;
        case EventParticipationStatus.Invited:
          byStatus.invited++;
          break;
        case EventParticipationStatus.Maybe:
          byStatus.maybe++;
          break;
        case EventParticipationStatus.NotAttending:
          byStatus.notAttending++;
          break;
      }
    }

    const occurrenceEntries: AvailabilitySummaryEntry[] = occurrences.map((occ) => {
      const occurrenceVotes = votesByOccurrence.get(occ.id) ?? [];
      let available = 0;
      let maybe = 0;
      let unavailable = 0;

      const countedVotes = occurrenceVotes.filter((vote) => vote.eligible);

      for (const vote of countedVotes) {
        switch (vote.response) {
          case AvailabilityResponse.Available:
            available++;
            break;
          case AvailabilityResponse.Maybe:
            maybe++;
            break;
          case AvailabilityResponse.Unavailable:
            unavailable++;
            break;
        }
      }

      const totalVotes = countedVotes.length;

      return {
        occurrenceId: occ.id,
        label: occ.label,
        startDate: occ.startDate,
        endDate: occ.endDate,
        status: occ.status,
        available,
        maybe,
        unavailable,
        totalVotes,
        pendingVotes: Math.max(0, eligibleVoters - totalVotes),
        participationRate: eligibleVoters > 0 ? Math.round((totalVotes / eligibleVoters) * 100) / 100 : 0,
        voters: occurrenceVotes.map((v) => ({
          attendeeId: v.attendeeId,
          response: v.response,
          eligible: v.eligible,
        })),
      } satisfies AvailabilitySummaryEntry;
    });

    return {
      attendees: {
        total: attendees.length,
        registered: registered.length,
        guests: guests.length,
        byStatus,
      },
      eligibleVoters,
      occurrences: occurrenceEntries,
    } satisfies AvailabilitySummary;
  }
}

/**
 * Each vote as the occurrence routes read it: the response, the attendee who
 * cast it, their user, whether they are still in the event, and whether their
 * event role holds the availability vote (#759), which
 * {@link toOccurrenceVote} turns into the vote's `eligible` mark.
 */
const OCCURRENCE_VOTE_SELECT = {
  id: true,
  attendeeId: true,
  response: true,

  attendee: {
    select: { status: true, removedAt: true, ...voterGrantSelect(AVAILABILITY_VOTE_SLUG) },
  },
} as const satisfies Prisma.EventAvailabilityVoteSelect;

type OccurrenceVoteRow = Prisma.EventAvailabilityVoteGetPayload<{ select: typeof OCCURRENCE_VOTE_SELECT }>;

/**
 * A vote as the occurrence routes serve it: the response, the attendee who
 * cast it and their user, and whether it counts. It counts while its voter
 * is in the event (#551) and their event role holds the availability vote
 * (#759), as in the availability summary; one who left, or whose role lost
 * the vote, keeps the vote, marked as not counting.
 */
export type OccurrenceVote = Omit<OccurrenceVoteRow, 'attendee'> & {
  attendee: Pick<OccurrenceVoteRow['attendee'], 'userId'>;
  eligible: boolean;
};

function toOccurrenceVote<TRow extends OccurrenceVoteRow>({
  attendee,
  ...vote
}: TRow): Omit<TRow, 'attendee'> & Pick<OccurrenceVote, 'attendee' | 'eligible'> {
  return { ...vote, attendee: { userId: attendee.userId }, eligible: countsAsVoter(attendee) };
}

// In the order each attendee first voted. A changed vote keeps its place, and
// `id` breaks ties between votes cast in the same millisecond.
const OCCURRENCE_VOTE_ORDER = [
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.EventAvailabilityVoteOrderByWithRelationInput[];

/** Each game on an occurrence: the lineup row and the platform game it schedules. */
const OCCURRENCE_GAME_SELECT = {
  id: true,
  platformGameId: true,
  role: true,
  platformGame: { select: PLATFORM_GAME_SUMMARY_SELECT },
} as const satisfies Prisma.EventGameSelect;

// In the host's order. `id` breaks ties on `sortOrder`, which defaults to 0,
// as it does for the occurrences themselves.
const OCCURRENCE_GAME_ORDER = [
  { sortOrder: 'asc' },
  { id: 'asc' },
] satisfies Prisma.EventGameOrderByWithRelationInput[];

/**
 * An occurrence as every occurrence route serves it, reads and writes alike:
 * the shape it had when the votes and games were embedded in it.
 */
export type OccurrenceDetail = Prisma.EventOccurrenceGetPayload<{
  include: {
    games: { select: typeof OCCURRENCE_GAME_SELECT };
  };
}> & { policy: OccurrencePolicyView | null; availabilityVotes: OccurrenceVote[] };

type VotesAndGames = Pick<OccurrenceDetail, 'availabilityVotes' | 'games'>;

/** Rows grouped under the occurrence each belongs to, without the key itself, in the order given. */
function groupByOccurrence<TRow extends { occurrenceId: string | null }>(
  rows: TRow[],
): Map<string, Omit<TRow, 'occurrenceId'>[]> {
  const groups = new Map<string, Omit<TRow, 'occurrenceId'>[]>();

  for (const { occurrenceId, ...row } of rows) {
    if (occurrenceId === null) {
      continue;
    }

    const group = groups.get(occurrenceId) ?? [];
    group.push(row);
    groups.set(occurrenceId, group);
  }

  return groups;
}

/** A date status transition: the date, the statuses it may start from, and the one it moves to. */
interface StatusTransition {
  eventId: string;
  occurrenceId: string;
  allowedFrom: OccurrenceStatus[];
  newStatus: OccurrenceStatus;
}

/** 404 for a date not in the event, 400 for one whose status the transition can't start from. */
function assertTransitionAllowed<TOccurrence extends { status: OccurrenceStatus }>(
  occurrence: TOccurrence | null,
  { eventId, occurrenceId, allowedFrom, newStatus }: StatusTransition,
): asserts occurrence is TOccurrence {
  assert(occurrence, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));
  assert(
    allowedFrom.includes(occurrence.status),
    new BadRequestException(
      t('errors.occurrence.invalid_transition', {
        from: occurrence.status,
        to: newStatus,
        allowed: allowedFrom.join(', '),
      }),
    ),
  );
}
