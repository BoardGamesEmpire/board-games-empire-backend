import {
  AvailabilityResponse,
  DatabaseService,
  EventAvailabilityVote,
  EventOccurrence,
  EventParticipationStatus,
  EventSchedulingMode,
  isPrismaDependentRecordNotFoundError,
  OccurrenceStatus,
} from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { accessibleBy, WhereInput } from '@casl/prisma';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { OccurrenceEvents } from './constants';
import { AddOccurrenceDto } from './dto/add-occurrence.dto';
import { SubmitAvailabilityDto } from './dto/submit-availability.dto';
import { UpdateEventOccurrenceDto } from './dto/update-event-occurrence.dto';
import type {
  AvailabilitySummary,
  AvailabilitySummaryEntry,
  AvailabilityVoteSubmittedEvent,
  OccurrenceAddedEvent,
  OccurrenceStatusChangedEvent,
} from './interfaces';

@Injectable()
export class EventOccurrenceService {
  private readonly logger = new Logger(EventOccurrenceService.name);

  constructor(private readonly db: DatabaseService, private readonly eventEmitter: EventEmitter2) {}

  async getOccurrences(eventId: string, abilities: AppAbility[]): Promise<EventOccurrence[]> {
    await this.assertEventExists(eventId);

    return this.db.eventOccurrence.findMany({
      where: {
        eventId,
        AND: this.createOccurrenceWhereAnd(abilities),
      },
      include: OCCURRENCE_INCLUDE,
      orderBy: { sortOrder: 'asc' },
    });
  }

  async getOccurrence(eventId: string, occurrenceId: string, abilities: AppAbility[]): Promise<EventOccurrence> {
    await this.assertEventExists(eventId);

    const occurrence = await this.db.eventOccurrence.findUnique({
      where: {
        id: occurrenceId,
        eventId,
        AND: this.createOccurrenceWhereAnd(abilities),
      },
      include: OCCURRENCE_INCLUDE,
    });

    assert(occurrence, new NotFoundException(`Occurrence ${occurrenceId} not found for event ${eventId}`));
    return occurrence;
  }

  async addOccurrence(eventId: string, dto: AddOccurrenceDto): Promise<EventOccurrence> {
    const event = await this.db.event.findUnique({
      where: { id: eventId, deletedAt: null },
      select: { id: true, schedulingMode: true },
    });

    assert(event, new NotFoundException(`Event ${eventId} not found`));

    if (event.schedulingMode === EventSchedulingMode.Fixed) {
      const existingCount = await this.db.eventOccurrence.count({
        where: { eventId },
      });

      if (existingCount >= 1) {
        throw new BadRequestException(
          'Fixed scheduling mode allows at most one occurrence. ' +
            'Change the event scheduling mode to Poll or MultiDay first.',
        );
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

    this.eventEmitter.emit(OccurrenceEvents.OccurrenceAdded, {
      eventId,
      occurrenceId: occurrence.id,
      status,
    } satisfies OccurrenceAddedEvent);

    return occurrence;
  }

  async updateOccurrence(
    eventId: string,
    occurrenceId: string,
    dto: UpdateEventOccurrenceDto,
    abilities: AppAbility[],
  ): Promise<EventOccurrence> {
    assert(Object.keys(dto).length > 0, new BadRequestException('At least one field must be provided for update'));

    const existing = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true },
    });

    assert(existing, new NotFoundException(`Occurrence ${occurrenceId} not found for event ${eventId}`));

    try {
      const updated = await this.db.eventOccurrence.update({
        where: {
          id: occurrenceId,
          AND: this.createOccurrenceWhereAnd(abilities),
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

      this.eventEmitter.emit(OccurrenceEvents.OccurrenceUpdated, {
        eventId,
        occurrenceId,
      });

      return updated;
    } catch (error) {
      this.logger.error(`Error updating occurrence ${occurrenceId} for event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException("You don't have permission to update this resource.");
      }
      throw error;
    }
  }

  async removeOccurrence(eventId: string, occurrenceId: string, abilities: AppAbility[]): Promise<EventOccurrence> {
    this.logger.debug(`Attempting to remove occurrence ${occurrenceId} from event ${eventId}`);

    const existing = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true },
    });

    assert(existing, new NotFoundException(`Occurrence ${occurrenceId} not found for event ${eventId}`));

    try {
      return this.db.eventOccurrence.delete({
        where: {
          id: occurrenceId,
          AND: this.createOccurrenceWhereAnd(abilities),
        },
        include: OCCURRENCE_INCLUDE,
      });
    } catch (error) {
      this.logger.error(`Error removing occurrence ${occurrenceId} from event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException("You don't have permission to remove this resource.");
      }
      throw error;
    }
  }

  async confirmOccurrence(eventId: string, occurrenceId: string, abilities: AppAbility[]): Promise<EventOccurrence> {
    return this.transitionStatus(
      eventId,
      occurrenceId,
      [OccurrenceStatus.Proposed],
      OccurrenceStatus.Confirmed,
      {
        confirmedAt: new Date(),
      },
      abilities,
    );
  }

  async declineOccurrence(eventId: string, occurrenceId: string, abilities: AppAbility[]): Promise<EventOccurrence> {
    return this.transitionStatus(
      eventId,
      occurrenceId,
      [OccurrenceStatus.Proposed],
      OccurrenceStatus.Declined,
      {
        declinedAt: new Date(),
      },
      abilities,
    );
  }

  async cancelOccurrence(eventId: string, occurrenceId: string, abilities: AppAbility[]): Promise<EventOccurrence> {
    return this.transitionStatus(
      eventId,
      occurrenceId,
      [OccurrenceStatus.Confirmed],
      OccurrenceStatus.Cancelled,
      {
        cancelledAt: new Date(),
      },
      abilities,
    );
  }

  private async transitionStatus(
    eventId: string,
    occurrenceId: string,
    allowedFrom: OccurrenceStatus[],
    newStatus: OccurrenceStatus,
    extraData: Record<string, unknown> = {},
    abilities: AppAbility[],
  ): Promise<EventOccurrence> {
    const existing = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true, status: true },
    });

    assert(existing, new NotFoundException(`Occurrence ${occurrenceId} not found for event ${eventId}`));

    if (!allowedFrom.includes(existing.status)) {
      throw new BadRequestException(
        `Cannot transition from "${existing.status}" to "${newStatus}". ` +
          `Allowed source statuses: ${allowedFrom.join(', ')}.`,
      );
    }

    try {
      const updated = await this.db.eventOccurrence.update({
        where: {
          id: occurrenceId,
          AND: this.createOccurrenceWhereAnd(abilities),
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

      this.eventEmitter.emit(domainEvent, {
        eventId,
        occurrenceId,
        previousStatus: existing.status,
        newStatus,
      } satisfies OccurrenceStatusChangedEvent);

      return updated;
    } catch (error) {
      this.logger.error(`Error transitioning occurrence ${occurrenceId} to ${newStatus}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException("You don't have permission to update this resource.");
      }
      throw error;
    }
  }

  async submitAvailability(
    eventId: string,
    occurrenceId: string,
    attendeeId: string,
    dto: SubmitAvailabilityDto,
  ): Promise<EventAvailabilityVote> {
    const occurrence = await this.db.eventOccurrence.findUnique({
      where: { id: occurrenceId, eventId },
      select: { id: true, status: true },
    });

    assert(occurrence, new NotFoundException(`Occurrence ${occurrenceId} not found for event ${eventId}`));

    if (occurrence.status !== OccurrenceStatus.Proposed) {
      throw new BadRequestException(
        `Availability votes are only accepted for Proposed occurrences. ` + `Current status: "${occurrence.status}".`,
      );
    }

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

    this.eventEmitter.emit(OccurrenceEvents.AvailabilityVoteSubmitted, {
      eventId,
      occurrenceId,
      attendeeId,
      response: dto.response,
    } satisfies AvailabilityVoteSubmittedEvent);

    return vote;
  }

  async getAvailabilitySummary(eventId: string, abilities: AppAbility[]): Promise<AvailabilitySummary> {
    await this.assertEventExists(eventId);

    const [attendees, occurrences] = await Promise.all([
      this.db.eventAttendee.findMany({
        where: { eventId },
        select: { userId: true, status: true },
      }),
      this.db.eventOccurrence.findMany({
        where: {
          eventId,
          AND: this.createOccurrenceWhereAnd(abilities),
        },
        include: {
          availabilityVotes: {
            select: {
              response: true,
              attendeeId: true,
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
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

  private createOccurrenceWhereAnd(abilities: AppAbility[]): WhereInput<EventOccurrence>[] {
    const whereAnd: WhereInput<EventOccurrence>[] = [];

    try {
      for (const ability of abilities) {
        if (ability) {
          whereAnd.push(accessibleBy(ability).EventOccurrence);
        }
      }
    } catch (error) {
      this.logger.error('Error creating where conditions for occurrence access control', error);
      throw new ForbiddenException("You don't have permission to access this resource.");
    }

    assert(whereAnd.length > 0, new ForbiddenException("You don't have permission to access this resource"));
    return whereAnd;
  }

  private async assertEventExists(eventId: string): Promise<void> {
    const count = await this.db.event.count({
      where: { id: eventId, deletedAt: null },
    });
    assert(count > 0, new NotFoundException(`Event ${eventId} not found`));
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
