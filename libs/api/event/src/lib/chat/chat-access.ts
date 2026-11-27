import type { Actor } from '@bge/actor-context';
import { sessionUserId } from '@bge/actor-context';
import type { EventParticipationStatus, Prisma } from '@bge/database';
import { EventChatAccess, SystemRole } from '@bge/database';
import { CHAT_ACCESS_STATUSES } from './chat-access-levels';
import type { ChatFacts, ChatPolicy } from './chat-facts';
import { loadChatFacts } from './chat-facts';

/** Why a user can't read an event chat, as a stable code (#1543). */
export type ChatReadRefusal =
  'EVENT_CHAT_USER_REQUIRED' | 'EVENT_CHAT_NOT_FOUND' | 'EVENT_CHAT_OFF' | 'EVENT_CHAT_READ_NOT_ALLOWED';

/** Why a user who reads an event chat can't post in it, as a stable code (#1543). */
export type ChatPostRefusal = 'EVENT_CHAT_READ_ONLY' | 'EVENT_CHAT_POST_NOT_ALLOWED' | 'EVENT_CHAT_MUTED';

/**
 * Whether a reader may post. A refusal carries the end of the host mute behind
 * it, null when it has none or isn't a host mute.
 */
export type ChatPost =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly mutedUntil: Date | null; readonly refusal: ChatPostRefusal };

/**
 * One user's access to one event chat (#1543). A reader's `attendeeId` is the
 * attendee row they read and post as, and `moderates` says whether they are a
 * host, co-host or event moderator there.
 */
export type ChatAccess =
  | { readonly canRead: false; readonly refusal: ChatReadRefusal }
  | { readonly attendeeId: string; readonly canRead: true; readonly moderates: boolean; readonly post: ChatPost };

/** The event roles that moderate an event chat: they read it whatever their RSVP, and no host mute stops them. */
const MODERATING_ROLES: readonly string[] = [SystemRole.EventHost, SystemRole.EventCoHost, SystemRole.EventModerator];

/** The schema's defaults, which an event with no policy row reads as (#1544). */
const DEFAULT_CHAT_POLICY: ChatPolicy = {
  chatEnabled: true,
  chatReadAccess: EventChatAccess.AllAttendees,
  chatPostAccess: EventChatAccess.AllAttendees,
  chatSpectatorsMayPost: false,
};

function admits(level: EventChatAccess, status: EventParticipationStatus): boolean {
  return CHAT_ACCESS_STATUSES[level].includes(status);
}

function refusePost(refusal: ChatPostRefusal, mutedUntil: Date | null = null): ChatPost {
  return { allowed: false, refusal, mutedUntil };
}

/**
 * A host mute holds from when it was set until its end, if it has one. At its
 * end it no longer holds.
 */
function isHostMuted(facts: ChatFacts, now: Date): boolean {
  return facts.hostMutedAt !== null && (facts.hostMutedUntil === null || facts.hostMutedUntil > now);
}

function decidePost(facts: ChatFacts, policy: ChatPolicy, moderates: boolean, now: Date): ChatPost {
  // Cancelled or archived, the chat is read-only for everyone, hosts included;
  // reopening or unarchiving restores posting.
  if (facts.cancelledAt !== null || facts.archivedAt !== null) {
    return refusePost('EVENT_CHAT_READ_ONLY');
  }

  // With the chat off, only its moderators still read it, and nobody posts.
  if (!policy.chatEnabled) {
    return refusePost('EVENT_CHAT_READ_ONLY');
  }

  if (moderates) {
    return { allowed: true };
  }

  if (facts.role === SystemRole.EventSpectator && !policy.chatSpectatorsMayPost) {
    return refusePost('EVENT_CHAT_POST_NOT_ALLOWED');
  }

  if (!admits(policy.chatPostAccess, facts.status)) {
    return refusePost('EVENT_CHAT_POST_NOT_ALLOWED');
  }

  if (isHostMuted(facts, now)) {
    return refusePost('EVENT_CHAT_MUTED', facts.hostMutedUntil);
  }

  return { allowed: true };
}

/**
 * Decides an attendee's access to their event's event chat from the facts
 * alone (#1543, #1544), with no actor and no ability: the event chat is
 * reached only through attendance, which no wildcard grant stands in for
 * (#1553). Null facts, or an attendee with no event role, are not found.
 */
export function decideChatAccess(facts: ChatFacts | null, now: Date): ChatAccess {
  if (facts === null || facts.role === null) {
    return { canRead: false, refusal: 'EVENT_CHAT_NOT_FOUND' };
  }

  const policy = facts.policy ?? DEFAULT_CHAT_POLICY;
  const moderates = MODERATING_ROLES.includes(facts.role);

  if (!moderates && !policy.chatEnabled) {
    return { canRead: false, refusal: 'EVENT_CHAT_OFF' };
  }

  if (!moderates && !admits(policy.chatReadAccess, facts.status)) {
    return { canRead: false, refusal: 'EVENT_CHAT_READ_NOT_ALLOWED' };
  }

  return { canRead: true, attendeeId: facts.attendeeId, moderates, post: decidePost(facts, policy, moderates, now) };
}

/**
 * The one entry point to event chat access (#1543): every chat route (#1545)
 * and the chat live topic's authorize (#1546) call it, so the two can't
 * disagree. It takes the actor explicitly, the route's caller or the topic's
 * subscriber, never the actor in scope.
 *
 * Only a registered user signed in as themself takes part. An API key, a
 * plugin (even one acting for a user), the system, a foreign system and an
 * anonymous user are refused before anything is read, so the refusal says
 * nothing about the event. Whether anonymous users join is #488's to decide.
 */
export async function chatAccess(
  db: Pick<Prisma.TransactionClient, 'eventAttendee'>,
  actor: Actor,
  eventId: string,
  now: Date = new Date(),
): Promise<ChatAccess> {
  const userId = sessionUserId(actor);

  if (userId === null) {
    return { canRead: false, refusal: 'EVENT_CHAT_USER_REQUIRED' };
  }

  return decideChatAccess(await loadChatFacts(db, userId, eventId), now);
}
