import type { EventParticipationStatus, EventPolicy, Prisma } from '@bge/database';
import { liveEventWhere } from '@bge/database';
import { NOT_REMOVED } from '../constants/not-removed.constant';

/** The event policy's event chat settings (#1544). */
export type ChatPolicy = Pick<
  EventPolicy,
  'chatEnabled' | 'chatPostAccess' | 'chatReadAccess' | 'chatSpectatorsMayPost'
>;

/**
 * What decides one user's access to one event's event chat (#1543): their
 * attendee row, its RSVP and event role, the event's state and chat settings,
 * and any host mute on them.
 */
export interface ChatFacts {
  readonly archivedAt: Date | null;
  readonly attendeeId: string;
  readonly cancelledAt: Date | null;
  readonly hostMutedAt: Date | null;
  readonly hostMutedUntil: Date | null;

  /** The event's chat settings, or null for an event with no policy row, which reads as the defaults. */
  readonly policy: ChatPolicy | null;

  /**
   * The event role's name, compared against the `SystemRole` names; a custom
   * event role (#1170) matches none of them. Null for an attendee with no role
   * row, which a removal leaves (#551).
   */
  readonly role: string | null;

  readonly status: EventParticipationStatus;
}

const CHAT_FACTS_SELECT = {
  id: true,
  status: true,
  role: { select: { role: { select: { name: true } } } },
  event: {
    select: {
      cancelledAt: true,
      archivedAt: true,
      policy: {
        select: { chatEnabled: true, chatReadAccess: true, chatPostAccess: true, chatSpectatorsMayPost: true },
      },
    },
  },
  chatState: { select: { hostMutedAt: true, hostMutedUntil: true } },
} as const satisfies Prisma.EventAttendeeSelect;

/**
 * Reads {@link ChatFacts} for a user on an event (#1543). Null when the event
 * isn't live, being soft-deleted or in a soft-deleted household (#992), or the
 * user has no attendee row on it that a host has not removed (#551).
 *
 * The read applies no actor's ability: chat access is decided from these
 * facts alone, so the where is the only filter. It reads the attendee's chat
 * state, never the event's chat messages.
 */
export async function loadChatFacts(
  db: Pick<Prisma.TransactionClient, 'eventAttendee'>,
  userId: string,
  eventId: string,
): Promise<ChatFacts | null> {
  const row = await db.eventAttendee.findFirst({
    where: { eventId, userId, ...NOT_REMOVED, event: { is: liveEventWhere() } },
    select: CHAT_FACTS_SELECT,
  });

  if (!row) {
    return null;
  }

  return {
    attendeeId: row.id,
    status: row.status,
    role: row.role?.role.name ?? null,
    cancelledAt: row.event.cancelledAt,
    archivedAt: row.event.archivedAt,
    policy: row.event.policy,
    hostMutedAt: row.chatState?.hostMutedAt ?? null,
    hostMutedUntil: row.chatState?.hostMutedUntil ?? null,
  };
}
