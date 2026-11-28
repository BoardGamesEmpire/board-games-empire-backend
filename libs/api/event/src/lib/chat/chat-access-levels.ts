import { EventChatAccess, EventParticipationStatus } from '@bge/database';

const { Attending, Invited, Maybe, NotAttending } = EventParticipationStatus;

/**
 * The RSVPs each event chat access level admits (#1544). An event's policy sets
 * one level for reading its event chat and one for posting in it. Every level
 * admits attending, and each narrower one drops an RSVP from the one above.
 */
export const CHAT_ACCESS_STATUSES: Readonly<Record<EventChatAccess, readonly EventParticipationStatus[]>> = {
  [EventChatAccess.AllAttendees]: [Attending, Invited, Maybe, NotAttending],
  [EventChatAccess.Responded]: [Attending, Maybe, NotAttending],
  [EventChatAccess.MaybeOrAttending]: [Attending, Maybe],
  [EventChatAccess.Attending]: [Attending],
};
