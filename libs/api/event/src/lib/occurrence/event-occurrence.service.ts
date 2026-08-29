import {
  Action,
  AvailabilityResponse,
  DatabaseService,
  EventAvailabilityVote,
  EventOccurrence,
  EventParticipationStatus,
  EventSchedulingMode,
  isPrismaDependentRecordNotFoundError,
  OccurrenceStatus,
  Prisma,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { OCCURRENCE_ORDER } from '../constants/occurrence-order.constant';
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
  ) {}

  /**
   * One page of an event's occurrences plus the total for the response envelope.
   *
   * This read was unpaginated until #372 — it returned every occurrence of the
   * event, however many that was. A nested list is a tempting exception ("an
   * event has a handful of dates"), but nothing in the schema bounds it, and an
   * unbounded list read is the #11 self-DoS with a smaller number in front of
   * it. D-372-1 paginates it; the response is a truncating change, which
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
   */
  async getOccurrences(eventId: string, pagination: PaginationQueryDto): Promise<PaginatedRows<EventOccurrence>> {
    await assertEventExists(this.db, eventId);

    const where: Prisma.EventOccurrenceWhereInput = {
      eventId,
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.read),
    };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.eventOccurrence.findMany({
          where,
          include: OCCURRENCE_INCLUDE,
          orderBy: OCCURRENCE_ORDER,
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.eventOccurrence.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  async getOccurrence(eventId: string, occurrenceId: string): Promise<EventOccurrence> {
    await assertEventExists(this.db, eventId);

    const occurrence = await this.db.eventOccurrence.findUnique({
      where: {
        id: occurrenceId,
        eventId,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.read),
      },
      include: OCCURRENCE_INCLUDE,
    });

    assert(occurrence, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));
    return occurrence;
  }

  async addOccurrence(eventId: string, dto: AddOccurrenceDto): Promise<EventOccurrence> {
    const initiatedAt = new Date();
    const event = await this.db.event.findUnique({
      where: { id: eventId, deletedAt: null },
      select: { id: true, schedulingMode: true },
    });

    assert(event, new NotFoundException(t('errors.event.not_found', { id: eventId })));

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
      include: OCCURRENCE_INCLUDE,
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

    return occurrence;
  }

  async updateOccurrence(
    eventId: string,
    occurrenceId: string,
    dto: UpdateEventOccurrenceDto,
  ): Promise<EventOccurrence> {
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
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.update),
        },
        data: {
          label: dto.label,
          startDate: dto.startDate,
          endDate: dto.endDate,
          location: dto.location,
          sortOrder: dto.sortOrder,
        },
        include: OCCURRENCE_INCLUDE,
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

      return updated;
    } catch (error) {
      this.logger.error(`Error updating occurrence ${occurrenceId} for event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }
      throw error;
    }
  }

  async removeOccurrence(eventId: string, occurrenceId: string): Promise<EventOccurrence> {
    this.logger.debug(`Attempting to remove occurrence ${occurrenceId} from event ${eventId}`);

    const existing = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true },
    });

    assert(existing, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

    try {
      return this.db.eventOccurrence.delete({
        where: {
          id: occurrenceId,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.delete),
        },
        include: OCCURRENCE_INCLUDE,
      });
    } catch (error) {
      this.logger.error(`Error removing occurrence ${occurrenceId} from event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.remove'));
      }
      throw error;
    }
  }

  async confirmOccurrence(eventId: string, occurrenceId: string): Promise<EventOccurrence> {
    return this.transitionStatus(eventId, occurrenceId, [OccurrenceStatus.Proposed], OccurrenceStatus.Confirmed, {
      confirmedAt: new Date(),
    });
  }

  async declineOccurrence(eventId: string, occurrenceId: string): Promise<EventOccurrence> {
    return this.transitionStatus(eventId, occurrenceId, [OccurrenceStatus.Proposed], OccurrenceStatus.Declined, {
      declinedAt: new Date(),
    });
  }

  async cancelOccurrence(eventId: string, occurrenceId: string): Promise<EventOccurrence> {
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
  ): Promise<EventOccurrence> {
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
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.update),
        },
        data: { status: newStatus, ...extraData },
        include: OCCURRENCE_INCLUDE,
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

      return updated;
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
   */
  async getAvailabilitySummary(eventId: string): Promise<AvailabilitySummary> {
    await assertEventExists(this.db, eventId);

    const [attendees, occurrences] = await Promise.all([
      this.db.eventAttendee.findMany({
        where: { eventId },
        select: { userId: true, status: true },
      }),
      this.db.eventOccurrence.findMany({
        where: {
          eventId,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.read),
        },
        include: {
          availabilityVotes: {
            select: {
              response: true,
              attendeeId: true,
            },
          },
        },
        orderBy: OCCURRENCE_ORDER,
      }),
    ]);

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
      let available = 0;
      let maybe = 0;
      let unavailable = 0;

      for (const vote of occ.availabilityVotes) {
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

      const totalVotes = occ.availabilityVotes.length;

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
        voters: occ.availabilityVotes.map((v) => ({
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

const OCCURRENCE_INCLUDE = {
  availabilityVotes: {
    select: {
      id: true,
      attendeeId: true,
      response: true,

      attendee: {
        select: { userId: true },
      },
    },
  },
  policy: true,
  games: {
    select: {
      id: true,
      gameId: true,
      role: true,
      game: { select: { id: true, title: true, thumbnail: true } },
    },
  },
} as const;
