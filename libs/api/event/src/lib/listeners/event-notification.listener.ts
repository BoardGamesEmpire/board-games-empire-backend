import { DatabaseService, NominationStatus, NotificationType } from '@bge/database';
import type { CreateNotificationInput } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AttendeeEvents } from '../attendee/constants';
import type { AttendeeAddedEvent, AttendeeStatusUpdatedEvent } from '../attendee/interfaces';
import { EventEvents } from '../constants/event-events.constant';
import type { EventCreatedEvent } from '../interfaces/event.interface';
import { NominationEvent } from '../nomination/constants';
import type {
  GameAddedToEventPayload,
  NominationCreatedEvent,
  NominationResolvedEvent,
} from '../nomination/interfaces';
import { OccurrenceEvents } from '../occurrence/constants/index';
import type { OccurrenceStatusChangedEvent } from '../occurrence/interfaces';

@Injectable()
export class EventNotificationListener {
  private readonly logger = new Logger(EventNotificationListener.name);

  constructor(private readonly db: DatabaseService, private readonly notifications: NotificationsService) {}

  @OnEvent(EventEvents.EventCreated, { async: true })
  async onEventCreated(event: EventCreatedEvent): Promise<void> {
    try {
      const notificationInputs: CreateNotificationInput[] = [];

      if (event.householdId) {
        const members = await this.db.householdMember.findMany({
          where: {
            householdId: event.householdId,
            userId: { notIn: [event.createdById, ...event.invitedUserIds] },
          },
          select: { userId: true },
        });

        for (const member of members) {
          notificationInputs.push({
            userId: member.userId,
            type: NotificationType.EventCreated,
            payload: {
              eventId: event.eventId,
              eventTitle: event.title,
            },
          });
        }
      }

      for (const inviteeId of event.invitedUserIds) {
        notificationInputs.push({
          userId: inviteeId,
          type: NotificationType.EventInviteReceived,
          payload: {
            eventId: event.eventId,
            eventTitle: event.title,
          },
        });
      }

      if (notificationInputs.length > 0) {
        await this.notifications.createMany(notificationInputs);
      }

      this.logger.debug(
        `EventCreated notifications: ${notificationInputs.length} sent for event ${event.eventId} ` +
          `(${event.invitedUserIds.length} invites)`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to notify on EventCreated eventId=${event.eventId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(AttendeeEvents.AttendeeAdded, { async: true })
  async onAttendeeAdded(event: AttendeeAddedEvent): Promise<void> {
    if (!event.userId) {
      // Guest attendees — no user to notify
      return this.logger.debug(
        `Attendee added without userId, skipping notification: eventId=${event.eventId}, attendeeId=${event.attendeeId}`,
      );
    }

    try {
      const eventRecord = await this.db.event.findUnique({
        where: { id: event.eventId },
        select: { title: true },
      });

      if (!eventRecord) {
        return this.logger.warn(`Event not found for AttendeeAdded notification, eventId=${event.eventId}`);
      }

      await this.notifications.create({
        userId: event.userId,
        type: NotificationType.EventInviteReceived,
        payload: {
          eventId: event.eventId,
          eventTitle: eventRecord.title,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on AttendeeAdded eventId=${event.eventId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(AttendeeEvents.AttendeeStatusUpdated, { async: true })
  async onAttendeeRsvp(event: AttendeeStatusUpdatedEvent): Promise<void> {
    try {
      // Notify the event host that someone RSVP'd
      const eventRecord = await this.db.event.findUnique({
        where: { id: event.eventId },
        select: { createdById: true, title: true },
      });

      if (!eventRecord || eventRecord.createdById === event.userId) {
        return this.logger.debug(
          `No notification needed for AttendeeStatusUpdated eventId=${event.eventId}, userId=${event.userId}`,
        );
      }

      const attendeeName = event.userId
        ? await this.db.user
            .findUnique({
              where: { id: event.userId },
              select: {
                username: true,
                profile: { select: { displayName: true } },
              },
            })
            .then((u) => u?.profile?.displayName ?? u?.username ?? 'Unknown')
        : 'A guest';

      await this.notifications.create({
        userId: eventRecord.createdById,
        type: NotificationType.EventRsvpReceived,
        payload: {
          eventId: event.eventId,
          eventTitle: eventRecord.title,
          attendeeName,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on AttendeeStatusUpdated eventId=${event.eventId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(NominationEvent.NominationCreated, { async: true })
  async onNominationCreated(event: NominationCreatedEvent): Promise<void> {
    try {
      const [eventRecord, platformGame] = await Promise.all([
        this.db.event.findUnique({
          where: { id: event.eventId },
          select: { title: true },
        }),
        this.db.platformGame.findUnique({
          where: { id: event.platformGameId },
          select: { id: true, game: { select: { title: true } } },
        }),
      ]);

      if (!eventRecord || !platformGame) {
        return this.logger.warn(
          `Event or game not found for NominationCreated notification, eventId=${event.eventId}, platformGameId=${event.platformGameId}`,
        );
      }

      // Notify all attendees except the nominator
      const attendees = await this.db.eventAttendee.findMany({
        where: { eventId: event.eventId, userId: { not: null } },
        select: { userId: true, id: true },
      });

      const inputs: CreateNotificationInput[] = attendees
        .filter((a) => a.id !== event.nominatedByAttendeeId && a.userId)
        .map((a) => ({
          userId: a.userId!,
          type: NotificationType.GameNominated,
          payload: {
            eventId: event.eventId,
            eventTitle: eventRecord.title,
            nominationId: event.nominationId,
            nominatedGameTitle: platformGame.game.title,
          },
        }));

      if (inputs.length > 0) {
        await this.notifications.createMany(inputs);
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify on NominationCreated nominationId=${event.nominationId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(NominationEvent.NominationResolved, { async: true })
  async onNominationResolved(event: NominationResolvedEvent): Promise<void> {
    try {
      const nomination = await this.db.eventGameNomination.findUnique({
        where: { id: event.nominationId },
        select: {
          nominatedById: true,
          nominatedBy: { select: { userId: true } },
          platformGame: {
            select: {
              id: true,

              game: { select: { title: true } },
            },
          },
        },
      });

      if (!nomination?.nominatedBy?.userId) {
        return this.logger.warn(
          `Nominator user not found for NominationResolved notification, nominationId=${event.nominationId}`,
        );
      }

      // Map resolution status to notification type
      let notificationType: NotificationType;
      switch (event.status) {
        case NominationStatus.Approved:
          notificationType = NotificationType.GameNominationApproved;
          break;
        case NominationStatus.Rejected:
          notificationType = NotificationType.GameNominationRejected;
          break;
        case NominationStatus.Passed:
          notificationType = NotificationType.GameNominationPassed;
          break;
        case NominationStatus.Failed:
        case NominationStatus.QuorumNotMet:
          notificationType = NotificationType.GameNominationFailed;
          break;
        default:
          return; // Withdrawn etc. — no notification
      }

      await this.notifications.create({
        userId: nomination.nominatedBy.userId,
        type: notificationType,
        payload: {
          eventId: event.eventId,
          nominationId: event.nominationId,
          nominatedGameTitle: nomination.platformGame.game.title,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on NominationResolved nominationId=${event.nominationId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(NominationEvent.GameAddedToEvent, { async: true })
  async onGameAdded(event: GameAddedToEventPayload): Promise<void> {
    try {
      const [eventRecord, platformGame] = await Promise.all([
        this.db.event.findUnique({
          where: { id: event.eventId },
          select: { title: true },
        }),
        this.db.platformGame.findUnique({
          where: { id: event.platformGameId },
          select: { id: true, game: { select: { title: true } } },
        }),
      ]);

      if (!eventRecord || !platformGame) {
        return this.logger.warn(
          `Event or game not found for GameAddedToEvent notification, eventId=${event.eventId}, platformGameId=${event.platformGameId}`,
        );
      }

      const attendees = await this.db.eventAttendee.findMany({
        where: { eventId: event.eventId, userId: { not: null } },
        select: { userId: true, id: true },
      });

      const inputs: CreateNotificationInput[] = attendees
        .filter((attendee) => attendee.id !== event.addedByAttendeeId && attendee.userId)
        .map((attendee) => ({
          userId: attendee.userId!,
          type: NotificationType.GameAddedToEvent,
          payload: {
            eventId: event.eventId,
            eventTitle: eventRecord.title,
            nominatedGameTitle: platformGame.game.title,
          },
        }));

      if (inputs.length > 0) {
        await this.notifications.createMany(inputs);
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify on GameAddedToEvent eventId=${event.eventId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(OccurrenceEvents.OccurrenceConfirmed, { async: true })
  async onOccurrenceConfirmed(event: OccurrenceStatusChangedEvent): Promise<void> {
    await this.notifyAttendeesOfOccurrenceChange(event, NotificationType.EventOccurrenceConfirmed);
  }

  @OnEvent(OccurrenceEvents.OccurrenceDeclined, { async: true })
  async onOccurrenceDeclined(event: OccurrenceStatusChangedEvent): Promise<void> {
    await this.notifyAttendeesOfOccurrenceChange(event, NotificationType.EventOccurrenceDeclined);
  }

  @OnEvent(OccurrenceEvents.OccurrenceCancelled, { async: true })
  async onOccurrenceCancelled(event: OccurrenceStatusChangedEvent): Promise<void> {
    await this.notifyAttendeesOfOccurrenceChange(event, NotificationType.EventOccurrenceCanceled);
  }

  private async notifyAttendeesOfOccurrenceChange(
    event: OccurrenceStatusChangedEvent,
    type: NotificationType,
  ): Promise<void> {
    try {
      const [eventRecord, occurrence] = await Promise.all([
        this.db.event.findUnique({
          where: { id: event.eventId },
          select: { title: true, createdById: true },
        }),
        this.db.eventOccurrence.findUnique({
          where: { id: event.occurrenceId },
          select: { label: true, startDate: true },
        }),
      ]);

      if (!eventRecord || !occurrence) {
        return this.logger.warn(
          `Event or occurrence not found for OccurrenceStatusChanged notification, eventId=${event.eventId}, occurrenceId=${event.occurrenceId}`,
        );
      }

      // Only notify attendees who voted on this occurrence
      const voters = await this.db.eventAvailabilityVote.findMany({
        where: { occurrenceId: event.occurrenceId },
        select: {
          attendeeId: true,
          attendee: {
            select: { userId: true },
          },
        },
      });

      const inputs: CreateNotificationInput[] = voters
        // filters guest attendees and any weird edge cases where userId is null
        .filter((v) => v.attendee.userId)
        .filter((v) => v.attendee.userId !== eventRecord.createdById)
        .map((v) => ({
          userId: v.attendee.userId!,
          type,
          payload: {
            eventId: event.eventId,
            eventTitle: eventRecord.title,
            occurrenceId: event.occurrenceId,
            occurrenceLabel: occurrence.label,
          },
        }));

      if (inputs.length > 0) {
        await this.notifications.createMany(inputs);
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify occurrence change occurrenceId=${event.occurrenceId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
