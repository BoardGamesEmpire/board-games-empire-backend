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
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { OCCURRENCE_ORDER } from '../constants/occurrence-order.constant';
import { PLATFORM_GAME_SUMMARY_SELECT } from '../constants/platform-game-summary.constant';
import { assertEventExists, resolveActingAttendeeId } from '../event-access.helpers';
import { pickSnapshot } from '../utils/pick-snapshot.util';
import { OccurrenceEvents } from './constants';
import { AddOccurrenceDto } from './dto/add-occurrence.dto';
import { SubmitAvailabilityDto } from './dto/submit-availability.dto';
import { UpdateEventOccurrenceDto } from './dto/update-event-occurrence.dto';
import {
  AvailabilityVoteSubmittedEvent,
  OccurrenceAddedEvent,
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
   * and bounded — an event soft-deleted between the probe and the read answers
   * 200 with an empty page rather than 404 — and it is the ordinary TOCTOU any
   * probe-then-read has. It says nothing about the rows and count, which do
   * share one snapshot.
   *
   * The scope is the path's event, composed with the caller's ceiling (#512).
   * Each occurrence's votes and games come from reads of their own, after the
   * page: see {@link withVotesAndGames}.
   */
  async getOccurrences(eventId: string, pagination: PaginationQueryDto): Promise<PaginatedRows<OccurrenceDetail>> {
    await assertEventExists(this.db, eventId);

    const where = this.scopeComposer.compose(ResourceType.EventOccurrence, Action.read, { eventId });

    const [occurrences, total] = await this.db.$transaction(
      [
        this.db.eventOccurrence.findMany({
          where,
          include: { policy: true },
          orderBy: OCCURRENCE_ORDER,
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.eventOccurrence.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: await this.withVotesAndGames(occurrences), total };
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
      include: { policy: true },
    });

    assert(occurrence, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

    const [detail] = await this.withVotesAndGames([occurrence]);
    return detail;
  }

  /**
   * The occurrences, each with its availability votes and games, read under
   * the votes' and the games' own ceilings (#560). Every occurrence route
   * answers through here, the writes as well as the reads.
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
   * They are read after the occurrences, outside the page's snapshot and
   * after a write's statement, since which occurrences to read them for is
   * the answer to that read or write. A vote cast in between can appear; it
   * is one on an occurrence the caller was served.
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

    const votesByOccurrence = groupByOccurrence(votes);
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
      select: { id: true, schedulingMode: true, householdId: true },
    });

    assert(event, new NotFoundException(t('errors.event.not_found', { id: eventId })));

    // The route's policy check judges a create by type alone; bind it to the
    // row about to be written — the event in the path, and that event's
    // household for the household-bound grants.
    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.EventOccurrence, {
      eventId,
      event: { householdId: event.householdId },
    });

    if (event.schedulingMode === EventSchedulingMode.Fixed) {
      const existingCount = await this.db.eventOccurrence.count({
        where: { eventId },
      });

      if (existingCount >= 1) {
        throw new BadRequestException(t('errors.occurrence.fixed_mode_single'));
      }
    }

    const status =
      dto.status ??
      (event.schedulingMode === EventSchedulingMode.Poll ? OccurrenceStatus.Proposed : OccurrenceStatus.Confirmed);

    const occurrence = await this.db.eventOccurrence.create({
      data: {
        event: { connect: { id: eventId } },
        label: dto.label,
        startDate: dto.startDate,
        endDate: dto.endDate,
        location: dto.location,
        status,
        sortOrder: dto.sortOrder ?? 0,
      },
      include: { policy: true },
    });

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

    const [detail] = await this.withVotesAndGames([occurrence]);
    return detail;
  }

  async updateOccurrence(
    eventId: string,
    occurrenceId: string,
    dto: UpdateEventOccurrenceDto,
  ): Promise<OccurrenceDetail> {
    const initiatedAt = new Date();
    assert(Object.keys(dto).length > 0, new BadRequestException(t('common.at_least_one_field')));

    // Full row (not just the id) so the update event can carry a before snapshot.
    const existing = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
    });

    assert(existing, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

    try {
      const updated = await this.db.eventOccurrence.update({
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
        include: { policy: true },
      });

      const changedKeys = (['label', 'startDate', 'endDate', 'location', 'sortOrder'] as const).filter(
        (key) => dto[key] !== undefined,
      );
      this.eventEmitter.emit(
        OccurrenceUpdatedEvent.eventName,
        new OccurrenceUpdatedEvent(
          pickSnapshot(existing, changedKeys),
          pickSnapshot(updated, changedKeys),
          initiatedAt,
        ),
      );

      const [detail] = await this.withVotesAndGames([updated]);
      return detail;
    } catch (error) {
      this.logger.error(`Error updating occurrence ${occurrenceId} for event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }
      throw error;
    }
  }

  async removeOccurrence(eventId: string, occurrenceId: string): Promise<OccurrenceDetail> {
    this.logger.debug(`Attempting to remove occurrence ${occurrenceId} from event ${eventId}`);

    const existing = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true },
    });

    assert(existing, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

    // The votes and games are deleted with the occurrence, so they are read
    // first, to answer with what was removed.
    const [{ availabilityVotes, games }] = await this.withVotesAndGames([existing]);

    try {
      const removed = await this.db.eventOccurrence.delete({
        where: {
          id: occurrenceId,
          // eslint-disable-next-line no-restricted-syntax -- single-row delete by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.delete),
        },
        include: { policy: true },
      });

      return { ...removed, availabilityVotes, games };
    } catch (error) {
      this.logger.error(`Error removing occurrence ${occurrenceId} from event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.remove'));
      }
      throw error;
    }
  }

  async confirmOccurrence(eventId: string, occurrenceId: string): Promise<OccurrenceDetail> {
    return this.transitionStatus(eventId, occurrenceId, [OccurrenceStatus.Proposed], OccurrenceStatus.Confirmed, {
      confirmedAt: new Date(),
    });
  }

  async declineOccurrence(eventId: string, occurrenceId: string): Promise<OccurrenceDetail> {
    return this.transitionStatus(eventId, occurrenceId, [OccurrenceStatus.Proposed], OccurrenceStatus.Declined, {
      declinedAt: new Date(),
    });
  }

  async cancelOccurrence(eventId: string, occurrenceId: string): Promise<OccurrenceDetail> {
    return this.transitionStatus(eventId, occurrenceId, [OccurrenceStatus.Confirmed], OccurrenceStatus.Cancelled, {
      cancelledAt: new Date(),
      cancelledById: this.abilityService.getActingUserId(),
    });
  }

  private async transitionStatus(
    eventId: string,
    occurrenceId: string,
    allowedFrom: OccurrenceStatus[],
    newStatus: OccurrenceStatus,
    extraData: Record<string, unknown> = {},
  ): Promise<OccurrenceDetail> {
    const initiatedAt = new Date();
    const existing = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true, status: true },
    });

    if (!existing) {
      throw new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId }));
    }

    if (!allowedFrom.includes(existing.status)) {
      throw new BadRequestException(
        t('errors.occurrence.invalid_transition', {
          from: existing.status,
          to: newStatus,
          allowed: allowedFrom.join(', '),
        }),
      );
    }

    try {
      const updated = await this.db.eventOccurrence.update({
        where: {
          id: occurrenceId,
          // Status transitions are mutations → filter by `update`, not `read`.
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.update),
        },
        data: { status: newStatus, ...extraData },
        include: { policy: true },
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
          { id: occurrenceId, eventId, status: existing.status },
          { id: updated.id, eventId: updated.eventId, status: updated.status },
          initiatedAt,
        ),
      );

      const [detail] = await this.withVotesAndGames([updated]);
      return detail;
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
        where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, { eventId }),
        select: { id: true, userId: true, status: true },
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

    const countedAttendeeIds = new Set(attendees.map((a) => a.id));
    const votesByOccurrence = groupByOccurrence(votes.filter((vote) => countedAttendeeIds.has(vote.attendeeId)));

    const registered = attendees.filter((a) => a.userId !== null);
    const guests = attendees.filter((a) => a.userId === null);
    const eligibleVoters = registered.length;

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

      for (const vote of occurrenceVotes) {
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

      const totalVotes = occurrenceVotes.length;

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

/** Each vote as the occurrence routes serve it: the response, the attendee who cast it, and their user. */
const OCCURRENCE_VOTE_SELECT = {
  id: true,
  attendeeId: true,
  response: true,

  attendee: {
    select: { userId: true },
  },
} as const satisfies Prisma.EventAvailabilityVoteSelect;

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
    policy: true;
    availabilityVotes: { select: typeof OCCURRENCE_VOTE_SELECT };
    games: { select: typeof OCCURRENCE_GAME_SELECT };
  };
}>;

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
