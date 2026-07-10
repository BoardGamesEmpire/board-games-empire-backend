import { DatabaseService, NominationStatus, NotificationType } from '@bge/database';
import type { CreateNotificationInput } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AttendeeEvents } from '../attendee/constants';
import type { AttendeeAddedEvent, AttendeeStatusUpdatedEvent } from '../attendee/events/attendee.events';
import { EventEvents } from '../constants/event-events.constant';
import type { EventCreatedEvent } from '../events/event.events';
import { NominationEvent } from '../nomination/constants';
import type {
  GameAddedToEventEvent,
  NominationCreatedEvent,
  NominationResolvedEvent,
} from '../nomination/events/nomination.events';
import { OccurrenceEvents } from '../occurrence/constants/index';
import type { OccurrenceStatusChangedEvent } from '../occurrence/events/occurrence.events';

@Injectable()
export class EventNotificationListener {
  private readonly logger = new Logger(EventNotificationListener.name);

  constructor(private readonly db: DatabaseService, private readonly notifications: NotificationsService) {}

  @OnEvent(EventEvents.EventCreated, { async: true })
  async onEventCreated(event: EventCreatedEvent): Promise<void> {
    const { id: eventId, title, householdId, createdById } = event.after;

    try {
      const notificationInputs: CreateNotificationInput[] = [];

      if (householdId) {
        const members = await this.db.householdMember.findMany({
          where: {
            householdId,
            userId: { notIn: [createdById, ...event.invitedUserIds] },
          },
          select: { userId: true },
        });

        for (const member of members) {
          notificationInputs.push({
            userId: member.userId,
            type: NotificationType.EventCreated,
            payload: {
              eventId,
              eventTitle: title,
            },
          });
        }
      }

      for (const inviteeId of event.invitedUserIds) {
        notificationInputs.push({
          userId: inviteeId,
          type: NotificationType.EventInviteReceived,
          payload: {
            eventId,
            eventTitle: title,
          },
        });
      }

      if (notificationInputs.length > 0) {
        await this.notifications.createMany(notificationInputs);
      }

      this.logger.debug(
        `EventCreated notifications: ${notificationInputs.length} sent for event ${eventId} ` +
          `(${event.invitedUserIds.length} invites)`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to notify on EventCreated eventId=${event.subjectId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(AttendeeEvents.AttendeeAdded, { async: true })
  async onAttendeeAdded(event: AttendeeAddedEvent): Promise<void> {
    const { id: attendeeId, eventId, userId } = event.after;

    if (!userId) {
      // Guest attendees — no user to notify
      return this.logger.debug(
        `Attendee added without userId, skipping notification: eventId=${eventId}, attendeeId=${attendeeId}`,
      );
    }

    try {
      const eventRecord = await this.db.event.findUnique({
        where: { id: eventId },
        select: { title: true },
      });

      if (!eventRecord) {
        return this.logger.warn(`Event not found for AttendeeAdded notification, eventId=${eventId}`);
      }

      await this.notifications.create({
        userId,
        type: NotificationType.EventInviteReceived,
        payload: {
          eventId,
          eventTitle: eventRecord.title,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on AttendeeAdded eventId=${eventId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(AttendeeEvents.AttendeeStatusUpdated, { async: true })
  async onAttendeeRsvp(event: AttendeeStatusUpdatedEvent): Promise<void> {
    const { eventId, userId } = event.after;

    try {
      // Notify the event host that someone RSVP'd
      const eventRecord = await this.db.event.findUnique({
        where: { id: eventId },
        select: { createdById: true, title: true },
      });

      if (!eventRecord || eventRecord.createdById === userId) {
        return this.logger.debug(
          `No notification needed for AttendeeStatusUpdated eventId=${eventId}, userId=${userId}`,
        );
      }

      const attendeeName = userId
        ? await this.db.user
            .findUnique({
              where: { id: userId },
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
          eventId,
          eventTitle: eventRecord.title,
          attendeeName,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on AttendeeStatusUpdated eventId=${eventId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(NominationEvent.NominationCreated, { async: true })
  async onNominationCreated(event: NominationCreatedEvent): Promise<void> {
    const { id: nominationId, eventId, platformGameId, nominatedById } = event.after;

    try {
      const [eventRecord, platformGame] = await Promise.all([
        this.db.event.findUnique({
          where: { id: eventId },
          select: { title: true },
        }),
        this.db.platformGame.findUnique({
          where: { id: platformGameId },
          select: { id: true, game: { select: { title: true } } },
        }),
      ]);

      if (!eventRecord || !platformGame) {
        return this.logger.warn(
          `Event or game not found for NominationCreated notification, eventId=${eventId}, platformGameId=${platformGameId}`,
        );
      }

      // Notify all attendees except the nominator
      const attendees = await this.db.eventAttendee.findMany({
        where: { eventId, userId: { not: null } },
        select: { userId: true, id: true },
      });

      const inputs: CreateNotificationInput[] = attendees
        .filter((a) => a.id !== nominatedById && a.userId)
        .map((a) => ({
          userId: a.userId!,
          type: NotificationType.GameNominated,
          payload: {
            eventId,
            eventTitle: eventRecord.title,
            nominationId,
            nominatedGameTitle: platformGame.game.title,
          },
        }));

      if (inputs.length > 0) {
        await this.notifications.createMany(inputs);
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify on NominationCreated nominationId=${nominationId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(NominationEvent.NominationResolved, { async: true })
  async onNominationResolved(event: NominationResolvedEvent): Promise<void> {
    const { id: nominationId, eventId, status } = event.after;

    try {
      const nomination = await this.db.eventGameNomination.findUnique({
        where: { id: nominationId },
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
          `Nominator user not found for NominationResolved notification, nominationId=${nominationId}`,
        );
      }

      // Map resolution status to notification type
      let notificationType: NotificationType;
      switch (status) {
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
          eventId,
          nominationId,
          nominatedGameTitle: nomination.platformGame.game.title,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on NominationResolved nominationId=${nominationId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(NominationEvent.GameAddedToEvent, { async: true })
  async onGameAdded(event: GameAddedToEventEvent): Promise<void> {
    // The row's own eventId is null for occurrence-scoped games — use the
    // context field, which always carries the parent event id.
    const { eventId, addedByAttendeeId } = event;
    const { platformGameId } = event.after;

    try {
      const [eventRecord, platformGame] = await Promise.all([
        this.db.event.findUnique({
          where: { id: eventId },
          select: { title: true },
        }),
        this.db.platformGame.findUnique({
          where: { id: platformGameId },
          select: { id: true, game: { select: { title: true } } },
        }),
      ]);

      if (!eventRecord || !platformGame) {
        return this.logger.warn(
          `Event or game not found for GameAddedToEvent notification, eventId=${eventId}, platformGameId=${platformGameId}`,
        );
      }

      const attendees = await this.db.eventAttendee.findMany({
        where: { eventId, userId: { not: null } },
        select: { userId: true, id: true },
      });

      const inputs: CreateNotificationInput[] = attendees
        .filter((attendee) => attendee.id !== addedByAttendeeId && attendee.userId)
        .map((attendee) => ({
          userId: attendee.userId!,
          type: NotificationType.GameAddedToEvent,
          payload: {
            eventId,
            eventTitle: eventRecord.title,
            nominatedGameTitle: platformGame.game.title,
          },
        }));

      if (inputs.length > 0) {
        await this.notifications.createMany(inputs);
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify on GameAddedToEvent eventId=${eventId}`,
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
    const { id: occurrenceId, eventId } = event.after;

    try {
      const [eventRecord, occurrence] = await Promise.all([
        this.db.event.findUnique({
          where: { id: eventId },
          select: { title: true, createdById: true },
        }),
        this.db.eventOccurrence.findUnique({
          where: { id: occurrenceId },
          select: { label: true, startDate: true },
        }),
      ]);

      if (!eventRecord || !occurrence) {
        return this.logger.warn(
          `Event or occurrence not found for OccurrenceStatusChanged notification, eventId=${eventId}, occurrenceId=${occurrenceId}`,
        );
      }

      // Only notify attendees who voted on this occurrence
      const voters = await this.db.eventAvailabilityVote.findMany({
        where: { occurrenceId },
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
            eventId,
            eventTitle: eventRecord.title,
            occurrenceId,
            occurrenceLabel: occurrence.label,
          },
        }));

      if (inputs.length > 0) {
        await this.notifications.createMany(inputs);
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify occurrence change occurrenceId=${occurrenceId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
