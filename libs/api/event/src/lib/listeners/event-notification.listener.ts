import { DatabaseService, InviteType, NominationStatus, NotificationType } from '@bge/database';
import { SHOWN_NAME_SELECT, shownName } from '@bge/household';
import type { InviteAcceptedEvent, InviteCreatedEvent, InviteDeclinedEvent, InviteSnapshot } from '@bge/invites';
import { InviteEvents } from '@bge/invites';
import type { CreateNotificationInput } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AttendeeEvents } from '../attendee/constants';
import type { AttendeeRemovedEvent, AttendeeStatusUpdatedEvent } from '../attendee/events/attendee.events';
import { EventEvents } from '../constants/event-events.constant';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import type { EventCreatedEvent, EventDeletedEvent } from '../events/event.events';
import { receivedEventInviteWhere } from '../invite/received-event-invites';
import type { EventCancelledEvent, EventReopenedEvent } from '../lifecycle/events/event-lifecycle.events';
import { NominationEvent } from '../nomination/constants';
import type {
  GameAddedToEventEvent,
  GameRemovedFromEventEvent,
  NominationCreatedEvent,
  NominationResolvedEvent,
} from '../nomination/events/nomination.events';
import { OccurrenceEvents } from '../occurrence/constants/index';
import type { OccurrenceStatusChangedEvent } from '../occurrence/events/occurrence.events';
import { hostUserIds, usersNotRemoved, usersStillComing, withoutActor } from './notification-audience';

/** An event invite's snapshot, which therefore names its event. */
type EventInviteSnapshot = InviteSnapshot & { readonly eventId: string };

/**
 * Whether the snapshot is an event invite, the only kind this listener tells
 * anyone about. Household invites are announced under the same `invite.*`
 * names, and are the household listener's (#742).
 */
function isEventInvite(invite: InviteSnapshot): invite is EventInviteSnapshot {
  return invite.type === InviteType.Event && invite.eventId !== null;
}

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
      // The creator's invitees are told by their invites' own `invite.created`
      // (#742), so the household's fan-out leaves them out rather than tell
      // them twice.
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

      if (notificationInputs.length > 0) {
        await this.notifications.createMany(notificationInputs);
      }

      this.logger.debug(`EventCreated notifications: ${notificationInputs.length} sent for event ${eventId}`);
    } catch (err) {
      this.logger.error(
        `Failed to notify on EventCreated eventId=${event.subjectId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * An event invite is told to its invitee (#742), exactly when their inbox
   * would list it: the inbox's own predicate is asked about this one invite,
   * so nobody hears of an invite they cannot see (a withheld one, #278, or one
   * to an event they already attend). A household invite is the household
   * listener's.
   */
  @OnEvent(InviteEvents.Created, { async: true })
  async onInviteCreated(event: InviteCreatedEvent): Promise<void> {
    const invite = event.after;

    if (!isEventInvite(invite) || invite.inviteeId === null) {
      return;
    }

    try {
      const inviteeId = invite.inviteeId;
      const listed = await this.db.invite.count({
        where: { id: invite.id, AND: [receivedEventInviteWhere(inviteeId, new Date())] },
      });

      if (listed !== 1) {
        return this.logger.debug(`Inbox lists no invite, skipping EventInviteReceived inviteId=${invite.id}`);
      }

      const [eventRecord, inviterName] = await Promise.all([
        this.db.event.findUnique({ where: { id: invite.eventId }, select: { title: true } }),
        this.nameOf(invite.inviterId),
      ]);

      if (!eventRecord || inviterName === null) {
        return this.logger.debug(`Event or inviter gone, skipping EventInviteReceived inviteId=${invite.id}`);
      }

      await this.notifications.create({
        userId: inviteeId,
        type: NotificationType.EventInviteReceived,
        payload: { eventId: invite.eventId, eventTitle: eventRecord.title, inviteId: invite.id, inviterName },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on InviteCreated inviteId=${invite.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** The invitee accepted and attends now (#742): the inviter is told who. */
  @OnEvent(InviteEvents.Accepted, { async: true })
  async onInviteAccepted(event: InviteAcceptedEvent): Promise<void> {
    await this.notifyInviterOfAnswer(event.after, NotificationType.EventInviteAccepted);
  }

  /** The invitee declined (#742): the inviter is told who. */
  @OnEvent(InviteEvents.Declined, { async: true })
  async onInviteDeclined(event: InviteDeclinedEvent): Promise<void> {
    await this.notifyInviterOfAnswer(event.after, NotificationType.EventInviteDeclined);
  }

  /**
   * Tells the inviter of an event invite how it was answered (#742), naming
   * the invitee as they are shown, never by an address. The invitee is the one
   * answering, so an inviter who is also the invitee is told nothing.
   */
  private async notifyInviterOfAnswer(
    invite: InviteSnapshot,
    type: typeof NotificationType.EventInviteAccepted | typeof NotificationType.EventInviteDeclined,
  ): Promise<void> {
    if (!isEventInvite(invite) || invite.inviteeId === null || invite.inviteeId === invite.inviterId) {
      return;
    }

    try {
      const [eventRecord, inviteeName] = await Promise.all([
        this.db.event.findUnique({ where: { id: invite.eventId }, select: { title: true } }),
        this.nameOf(invite.inviteeId),
      ]);

      if (!eventRecord || inviteeName === null) {
        return this.logger.debug(`Event or invitee gone, skipping ${type} inviteId=${invite.id}`);
      }

      await this.notifications.create({
        userId: invite.inviterId,
        type,
        payload: { eventId: invite.eventId, eventTitle: eventRecord.title, inviteId: invite.id, inviteeName },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify the inviter on ${type} inviteId=${invite.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  @OnEvent(AttendeeEvents.AttendeeStatusUpdated, { async: true })
  async onAttendeeRsvp(event: AttendeeStatusUpdatedEvent): Promise<void> {
    const { eventId, userId, status } = event.after;
    const { actingUserId } = event;

    // An edit of only the attendee's notes arrives with the status unchanged
    // (a send that changes nothing arrives not at all, #903). Neither is news
    // to anyone (#802).
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

  /** A user's name as the household notifications show it, or null once the user is deleted. */
  private async nameOf(userId: string): Promise<string | null> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: SHOWN_NAME_SELECT });

    return user ? shownName(user) : null;
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
          notificationType = NotificationType.GameNominationFailed;
          break;
        // Not Failed: everyone who voted may have voted For (#798).
        case NominationStatus.QuorumNotMet:
          notificationType = NotificationType.GameNominationQuorumNotMet;
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
      const titles = await this.lineupGameTitles('GameAddedToEvent', eventId, platformGameId);

      if (!titles) {
        return;
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
            eventTitle: titles.eventTitle,
            nominatedGameTitle: titles.gameTitle,
            nominatedGameSubtitle: titles.gameSubtitle,
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
   * #769. Every removal tells the attendees still coming, whatever the reason
   * (a host's removal, the supplier leaving, a date write that found nobody
   * bringing it, the supplier removing the game from their collection,
   * #1221), except the person acting. A supplier who left is out of
   * that audience already. The reason rides on the notification so the client
   * can say why.
   */
  @OnEvent(NominationEvent.GameRemovedFromEvent, { async: true })
  async onGameRemoved(event: GameRemovedFromEventEvent): Promise<void> {
    const { eventId, reason, actingUserId } = event;
    const { id: lineupGameId, occurrenceId, platformGameId } = event.before;

    try {
      const titles = await this.lineupGameTitles('GameRemovedFromEvent', eventId, platformGameId);

      if (!titles) {
        return;
      }

      const recipients = withoutActor(await usersStillComing(this.db, eventId), actingUserId);

      if (recipients.length > 0) {
        await this.notifications.createMany(
          recipients.map((userId) => ({
            userId,
            type: NotificationType.GameRemovedFromEvent,
            payload: {
              eventId,
              eventTitle: titles.eventTitle,
              lineupGameId,
              occurrenceId,
              gameTitle: titles.gameTitle,
              gameSubtitle: titles.gameSubtitle,
              reason,
            },
          })),
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify on GameRemovedFromEvent eventId=${eventId} lineupGameId=${lineupGameId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * The event's title and the game's, with its subtitle so two editions that
   * share a title can be told apart (#1271), which a lineup game's
   * notifications carry, or `null` with a warning when either is gone. `domainEvent` names
   * the domain event in the warning.
   */
  private async lineupGameTitles(
    domainEvent: 'GameAddedToEvent' | 'GameRemovedFromEvent',
    eventId: string,
    platformGameId: string,
  ): Promise<{ eventTitle: string; gameSubtitle: string | null; gameTitle: string } | null> {
    const [eventRecord, platformGame] = await Promise.all([
      this.db.event.findUnique({
        where: { id: eventId },
        select: { title: true },
      }),
      this.db.platformGame.findUnique({
        where: { id: platformGameId },
        select: { id: true, game: { select: { title: true, subtitle: true } } },
      }),
    ]);

    if (!eventRecord || !platformGame) {
      this.logger.warn(
        `Event or game not found for ${domainEvent} notification, eventId=${eventId}, platformGameId=${platformGameId}`,
      );
      return null;
    }

    return {
      eventTitle: eventRecord.title,
      gameTitle: platformGame.game.title,
      gameSubtitle: platformGame.game.subtitle,
    };
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
