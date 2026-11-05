import { DatabaseService, NominationStatus, NotificationType } from '@bge/database';
import type { CreateNotificationInput } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AttendeeEvents } from '../attendee/constants';
import type {
  AttendeeAddedEvent,
  AttendeeRemovedEvent,
  AttendeeStatusUpdatedEvent,
} from '../attendee/events/attendee.events';
import { EventEvents } from '../constants/event-events.constant';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import type { EventCreatedEvent, EventDeletedEvent } from '../events/event.events';
import type { EventCancelledEvent, EventReopenedEvent } from '../lifecycle/events/event-lifecycle.events';
import { NominationEvent } from '../nomination/constants';
import type {
  GameAddedToEventEvent,
  NominationCreatedEvent,
  NominationResolvedEvent,
} from '../nomination/events/nomination.events';
import { OccurrenceEvents } from '../occurrence/constants/index';
import type { OccurrenceStatusChangedEvent } from '../occurrence/events/occurrence.events';
import { hostUserIds, usersNotRemoved, usersStillComing, withoutActor } from './notification-audience';

@Injectable()
export class EventNotificationListener {
  private readonly logger = new Logger(EventNotificationListener.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

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
    const { eventId, userId, status } = event.after;
    const { actingUserId } = event;

    // The status is required on every write, so editing only an attendee's
    // notes sends the RSVP again unchanged. That is no news to anyone (#802).
    if (event.before.status === status) {
      return this.logger.debug(`RSVP unchanged for AttendeeStatusUpdated eventId=${eventId}, userId=${userId}`);
    }

    try {
      // Someone else changed this attendee's RSVP, so they are told (#802).
      // An attendee without an account has nobody to tell, and a person is
      // not told of their own answer.
      const rsvpChangedFor = userId !== null && userId !== actingUserId ? userId : null;

      const [hostIds, eventRecord] = await Promise.all([
        hostUserIds(this.db, eventId),
        this.db.event.findUnique({ where: { id: eventId }, select: { title: true } }),
      ]);

      if (!eventRecord) {
        return this.logger.warn(`Event not found for AttendeeStatusUpdated notification, eventId=${eventId}`);
      }

      // The hosts hear of an RSVP, not the creator (#802), and not the host
      // who answered or changed it themselves. A host whose own RSVP someone
      // else changed hears once, as the attendee.
      const hosts = withoutActor(hostIds, actingUserId).filter((hostId) => hostId !== rsvpChangedFor);

      if (hosts.length === 0 && rsvpChangedFor === null) {
        return this.logger.debug(
          `No notification needed for AttendeeStatusUpdated eventId=${eventId}, userId=${userId}`,
        );
      }

      const [attendeeName, changedByName] = await Promise.all([
        userId === null ? null : this.displayNameOf(userId),
        rsvpChangedFor === null || actingUserId === null ? null : this.displayNameOf(actingUserId),
      ]);

      // Every user has a username, so a missing name is a user deleted since
      // the RSVP. There is nobody to name to the hosts, and nobody to tell.
      if (userId !== null && attendeeName === null) {
        return this.logger.debug(`Attendee's user is gone for AttendeeStatusUpdated eventId=${eventId}`);
      }

      const inputs: CreateNotificationInput[] = hosts.map((hostId) => ({
        userId: hostId,
        type: NotificationType.EventRsvpReceived,
        // `null` is an attendee without an account, and the client words it.
        payload: { eventId, eventTitle: eventRecord.title, attendeeName },
      }));

      if (rsvpChangedFor !== null) {
        // `changedByName` is `null` for a plugin or the system, and the client words it.
        inputs.push({
          userId: rsvpChangedFor,
          type: NotificationType.EventRsvpChanged,
          payload: { eventId, eventTitle: eventRecord.title, status, changedByName },
        });
      }

      await this.notifications.createMany(inputs);
    } catch (err) {
      this.logger.error(
        `Failed to notify on AttendeeStatusUpdated eventId=${eventId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * #802. The person removed is told, unless they removed themselves. An
   * attendee without an account has nobody to tell.
   */
  @OnEvent(AttendeeEvents.AttendeeRemoved, { async: true })
  async onAttendeeRemoved(event: AttendeeRemovedEvent): Promise<void> {
    const { eventId, userId } = event.after;

    if (userId === null || userId === event.actingUserId) {
      return this.logger.debug(`No notification needed for AttendeeRemoved eventId=${eventId}`);
    }

    try {
      const eventRecord = await this.db.event.findUnique({
        where: { id: eventId },
        select: { title: true },
      });

      if (!eventRecord) {
        return this.logger.warn(`Event not found for AttendeeRemoved notification, eventId=${eventId}`);
      }

      await this.notifications.create({
        userId,
        type: NotificationType.EventAttendeeRemoved,
        payload: { eventId, eventTitle: eventRecord.title },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on AttendeeRemoved eventId=${eventId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async displayNameOf(userId: string): Promise<string | null> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { username: true, profile: { select: { displayName: true } } },
    });

    return user?.profile?.displayName ?? user?.username ?? null;
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
        where: { eventId, userId: { not: null }, ...NOT_REMOVED },
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
          nominatedBy: { select: { userId: true, removedAt: true } },
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

      // The nomination outlives its nominator's removal (#551); they hear
      // nothing more from the event, as the other notifications here skip them.
      if (nomination.nominatedBy.removedAt !== null) {
        return this.logger.debug(
          `Nominator was removed, skipping NominationResolved notification, nominationId=${nominationId}`,
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
        where: { eventId, userId: { not: null }, ...NOT_REMOVED },
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

  /**
   * #795. One notification per attendee, with the host's reason, rather than
   * one per cancelled date. The cancel moves its dates in bulk writes that
   * emit no date events, so this is the only word of it.
   */
  @OnEvent(EventEvents.EventCancelled, { async: true })
  async onEventCancelled(event: EventCancelledEvent): Promise<void> {
    const { id: eventId, title, cancelReason } = event.after;

    await this.notifyAttendeesOfEvent(eventId, event.actingUserId, (userId) => ({
      userId,
      type: NotificationType.EventCancelled,
      payload: { eventId, eventTitle: title, reason: cancelReason },
    }));
  }

  @OnEvent(EventEvents.EventReopened, { async: true })
  async onEventReopened(event: EventReopenedEvent): Promise<void> {
    const { id: eventId, title } = event.after;

    await this.notifyAttendeesOfEvent(eventId, event.actingUserId, (userId) => ({
      userId,
      type: NotificationType.EventReopened,
      payload: { eventId, eventTitle: title },
    }));
  }

  /**
   * #802. The attendees who were not removed, except the person deleting it.
   * The title rides the domain event, because the event is already gone.
   */
  @OnEvent(EventEvents.EventDeleted, { async: true })
  async onEventDeleted(event: EventDeletedEvent): Promise<void> {
    const { id: eventId, title } = event.before;

    await this.notifyAttendeesOfEvent(eventId, event.actingUserId, (userId) => ({
      userId,
      type: NotificationType.EventDeleted,
      payload: { eventId, eventTitle: title },
    }));
  }

  /**
   * Tells every attendee of the event who has an account and was not removed,
   * whatever their RSVP, Invited and Declined included, except the person
   * acting (#795). Each user once.
   */
  private async notifyAttendeesOfEvent(
    eventId: string,
    actingUserId: string | null,
    notificationFor: (userId: string) => CreateNotificationInput,
  ): Promise<void> {
    try {
      const recipients = withoutActor(await usersNotRemoved(this.db, eventId), actingUserId);

      if (recipients.length > 0) {
        await this.notifications.createMany(recipients.map(notificationFor));
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify the attendees of event ${eventId}`,
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

  /**
   * Tells the attendees still coming about a date's confirm, decline or
   * cancel, except the person acting (#802). The date's label rides on the
   * domain event, so a date deleted right after its cancel still gets its
   * notification (#677).
   */
  private async notifyAttendeesOfOccurrenceChange(
    event: OccurrenceStatusChangedEvent,
    type: NotificationType,
  ): Promise<void> {
    const { id: occurrenceId, eventId } = event.after;

    try {
      const eventRecord = await this.db.event.findUnique({
        where: { id: eventId },
        select: { title: true },
      });

      if (!eventRecord) {
        return this.logger.warn(
          `Event not found for OccurrenceStatusChanged notification, eventId=${eventId}, occurrenceId=${occurrenceId}`,
        );
      }

      const recipients = withoutActor(await usersStillComing(this.db, eventId), event.actingUserId);

      if (recipients.length > 0) {
        await this.notifications.createMany(
          recipients.map((userId) => ({
            userId,
            type,
            payload: {
              eventId,
              eventTitle: eventRecord.title,
              occurrenceId,
              occurrenceLabel: event.occurrenceLabel,
            },
          })),
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify occurrence change occurrenceId=${occurrenceId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
