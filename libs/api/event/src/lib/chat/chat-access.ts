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
 * Whether a reader may post (#1543). A refusal carries the end of the host
 * mute behind it, null when it has none or isn't a host mute.
 */
export type ChatPost =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly mutedUntil: Date | null; readonly refusal: ChatPostRefusal };

/**
 * One user's access to one event chat (#1543). A reader's `attendeeId` is the
 * attendee row they read and post as, and `moderates` says whether their event
 * role may remove anyone's message there, as a host, co-host and event
 * moderator's may.
 */
export type ChatAccess =
  | { readonly canRead: false; readonly refusal: ChatReadRefusal }
  | { readonly attendeeId: string; readonly canRead: true; readonly moderates: boolean; readonly post: ChatPost };

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
 * end it no longer holds (#1543).
 */
function isHostMuted(facts: ChatFacts, now: Date): boolean {
  return facts.hostMutedAt !== null && (facts.hostMutedUntil === null || facts.hostMutedUntil > now);
}

/**
 * Why an attendee can't read, or null when they can. Their event role must
 * hold the chat's read (#1543). Past that, a moderator always reads (#1544).
 * For anyone else, with the chat off it is hidden from them, and its messages
 * are kept (#1544).
 */
function readRefusal(facts: ChatFacts, policy: ChatPolicy): ChatReadRefusal | null {
  if (!facts.grants.read) {
    return 'EVENT_CHAT_READ_NOT_ALLOWED';
  }

  if (facts.grants.moderate) {
    return null;
  }

  if (!policy.chatEnabled) {
    return 'EVENT_CHAT_OFF';
  }

  if (!admits(policy.chatReadAccess, facts.status)) {
    return 'EVENT_CHAT_READ_NOT_ALLOWED';
  }

  return null;
}

function decidePost(facts: ChatFacts, policy: ChatPolicy, now: Date): ChatPost {
  // Cancelled or archived, the chat is read-only for everyone, hosts included;
  // reopening or unarchiving restores posting (#1544).
  if (facts.cancelledAt !== null || facts.archivedAt !== null) {
    return refusePost('EVENT_CHAT_READ_ONLY');
  }

  // An event role that doesn't hold the chat's post never posts, whatever
  // the event policy says (#1543).
  if (!facts.grants.post) {
    return refusePost('EVENT_CHAT_POST_NOT_ALLOWED');
  }

  // Hosts, co-hosts and event moderators always post, the chat off included
  // (#1544).
  if (facts.grants.moderate) {
    return { allowed: true };
  }

  // A spectator posts only where the event policy lets spectators post
  // (#1544).
  if (facts.role === SystemRole.EventSpectator && !policy.chatSpectatorsMayPost) {
    return refusePost('EVENT_CHAT_POST_NOT_ALLOWED');
  }

  if (!admits(policy.chatPostAccess, facts.status)) {
    return refusePost('EVENT_CHAT_POST_NOT_ALLOWED');
  }

  // The host mute is checked last, so a reader who couldn't post anyway is
  // told why, with no host mute's end to wait for (#1543).
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
  const refusal = readRefusal(facts, policy);

  if (refusal !== null) {
    return { canRead: false, refusal };
  }

  return {
    canRead: true,
    attendeeId: facts.attendeeId,
    moderates: facts.grants.moderate,
    post: decidePost(facts, policy, now),
  };
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
