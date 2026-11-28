import type { EventParticipationStatus, EventPolicy, PermissionSlug, Prisma } from '@bge/database';
import { liveEventWhere } from '@bge/database';
import { NOT_REMOVED } from '../constants/not-removed.constant';

/** The event policy's chat controls (#1544). */
export type ChatPolicy = Pick<
  EventPolicy,
  'chatEnabled' | 'chatPostAccess' | 'chatReadAccess' | 'chatSpectatorsMayPost'
>;

/** The permission an event role needs for its attendee to read the event chat (#1543). */
export const CHAT_READ_SLUG = 'read:event_chat_message' satisfies PermissionSlug;

/** The permission an event role needs for its attendee to post in the event chat (#1543). */
export const CHAT_POST_SLUG = 'create:event_chat_message' satisfies PermissionSlug;

/**
 * The permission that makes an event role's attendee moderate the event chat
 * (#1543): removing anyone's message. The catalog gives it to the host,
 * co-host and event moderator.
 */
export const CHAT_MODERATE_SLUG = 'delete:event_chat_message' satisfies PermissionSlug;

const CHAT_GRANT_SLUGS: readonly string[] = [CHAT_READ_SLUG, CHAT_POST_SLUG, CHAT_MODERATE_SLUG];

/** Which of the chat's permissions an attendee's event role holds (#1543). */
export interface ChatGrants {
  readonly moderate: boolean;
  readonly post: boolean;
  readonly read: boolean;
}

/** The {@link ChatGrants} a role holding `slugs` has (#1543). */
export function chatGrantsOf(slugs: readonly string[]): ChatGrants {
  return {
    read: slugs.includes(CHAT_READ_SLUG),
    post: slugs.includes(CHAT_POST_SLUG),
    moderate: slugs.includes(CHAT_MODERATE_SLUG),
  };
}

/**
 * What decides one user's access to one event's event chat (#1543): their
 * attendee row, its RSVP and event role, what that role is granted in the
 * chat, the event's state, the event policy's chat controls, and any host
 * mute on them.
 */
export interface ChatFacts {
  readonly archivedAt: Date | null;
  readonly attendeeId: string;
  readonly cancelledAt: Date | null;

  /** What the event role is granted in the chat; none of it for an attendee with no role row. */
  readonly grants: ChatGrants;

  readonly hostMutedAt: Date | null;
  readonly hostMutedUntil: Date | null;

  /** The event policy's chat controls, or null for an event with no policy row, which reads as the defaults. */
  readonly policy: ChatPolicy | null;

  /**
   * The event role's name, which says whether the attendee is a spectator.
   * Null for an attendee with no role row, which a removal leaves (#551).
   */
  readonly role: string | null;

  readonly status: EventParticipationStatus;
}

const CHAT_FACTS_SELECT = {
  id: true,
  status: true,
  role: {
    select: {
      role: {
        select: {
          name: true,
          permissions: {
            where: {
              revokedAt: null,
              permission: { is: { slug: { in: [...CHAT_GRANT_SLUGS] }, retiredAt: null, inverted: false } },
            },
            select: { permission: { select: { slug: true } } },
          },
        },
      },
    },
  },
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
 * The role's chat grants are read live, as a vote's are (#759), so access
 * follows a grant the Owner adds to or takes from an event role (#772). A
 * revoked grant, a retired permission and an inverted one confer nothing.
 * A grant's conditions are not read: the catalog's guards hold every chat
 * permission to the conditions it ships with, so the Owner can't narrow one
 * (#1543).
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
    grants: chatGrantsOf(row.role?.role.permissions.map(({ permission }) => permission.slug) ?? []),
    cancelledAt: row.event.cancelledAt,
    archivedAt: row.event.archivedAt,
    policy: row.event.policy,
    hostMutedAt: row.chatState?.hostMutedAt ?? null,
    hostMutedUntil: row.chatState?.hostMutedUntil ?? null,
  };
}
