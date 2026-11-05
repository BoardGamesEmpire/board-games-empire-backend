import { DatabaseService, EventParticipationStatus, Prisma, SystemRole } from '@bge/database';
import { NOT_REMOVED } from '../constants/not-removed.constant';

/**
 * The users behind an event's attendees who have an account and were not
 * removed, narrowed by `where`. Each user once. The audiences below differ
 * only in that narrowing, so the rule they share lives here (#802).
 */
async function attendeeUserIds(
  db: DatabaseService,
  eventId: string,
  where: Prisma.EventAttendeeWhereInput = {},
): Promise<string[]> {
  const attendees = await db.eventAttendee.findMany({
    where: { ...where, eventId, ...NOT_REMOVED, userId: { not: null } },
    select: { userId: true },
  });

  return [...new Set(attendees.flatMap(({ userId }) => (userId === null ? [] : [userId])))];
}

/**
 * The users an event's date notifications reach: every attendee with an
 * account who was not removed and has not answered not attending, whether
 * they are Attending, Maybe or Invited and whether or not they voted (#802).
 * Each user once. A date's delete leaves these rows in place, so a cancel
 * followed by a delete still reaches them (#677).
 *
 * This is the one place the rule lives: #680 narrows it to "attending that
 * date".
 */
export function usersStillComing(db: DatabaseService, eventId: string): Promise<string[]> {
  return attendeeUserIds(db, eventId, { status: { not: EventParticipationStatus.NotAttending } });
}

/**
 * Every attendee with an account who was not removed, whatever their RSVP,
 * Invited and Declined included. Each user once. This is the rule #795 uses
 * for the whole event (#802).
 */
export function usersNotRemoved(db: DatabaseService, eventId: string): Promise<string[]> {
  return attendeeUserIds(db, eventId);
}

/**
 * The event's current hosts and co-hosts who were not removed (#802). The
 * creator is not a host by being the creator, and an event nobody hosts has
 * none. Each user once.
 */
export function hostUserIds(db: DatabaseService, eventId: string): Promise<string[]> {
  return attendeeUserIds(db, eventId, {
    role: { is: { role: { is: { name: { in: [SystemRole.EventHost, SystemRole.EventCoHost] } } } } },
  });
}

/**
 * Leaves the person acting out of a notification. `null` means the actor is
 * not a user (system, external or plugin), so nobody is left out (#802).
 */
export function withoutActor(userIds: readonly string[], actingUserId: string | null): string[] {
  return userIds.filter((userId) => userId !== actingUserId);
}
