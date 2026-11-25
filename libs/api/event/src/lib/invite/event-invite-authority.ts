import type { DatabaseService, Prisma } from '@bge/database';
import { Action, ResourceType, SystemRole } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import type { AbilityService } from '@bge/permissions';
import { Http } from '@status/codes';
import type { AssignableAttendeeRole } from '../attendee/dto/add-attendee.dto';
import { ASSIGNABLE_ATTENDEE_ROLES } from '../attendee/dto/add-attendee.dto';
import { NOT_REMOVED } from '../constants/not-removed.constant';

/**
 * Each live attendee's user id and event role: what the event invite grants'
 * role clause reads off an instance (#742). The routes ask about the event's
 * whole roster, as the condition is written over it, for the reason the
 * household roster gives (`household-authority.ts`).
 */
export const EVENT_ROSTER_SELECT = {
  userId: true,
  role: { select: { role: { select: { name: true } } } },
} as const satisfies Prisma.EventAttendeeSelect;

export type EventRosterRow = Prisma.EventAttendeeGetPayload<{ select: typeof EVENT_ROSTER_SELECT }>;

/**
 * What the event invite grants read off an event, beside the invite (#742):
 * its household, its live roster with each attendee's event role, and the
 * event policy's `allowMemberInvites`. Only the event's own policy row: an
 * occurrence's policy says nothing about inviting.
 */
export interface EventInviteAuthority {
  readonly allowMemberInvites: boolean;
  readonly attendees: readonly EventRosterRow[];
  readonly eventId: string;
  readonly householdId: string | null;
}

/**
 * Reads an event's {@link EventInviteAuthority} in one query, as `client`
 * sees it. A missing event reads as an empty roster with no household, which
 * no invite grant matches but staff's. The event's lock or liveness check
 * answers it 404. An event with no policy row has the schema's default, which
 * lets attendees invite.
 */
export async function readEventInviteAuthority(
  client: DatabaseService | Prisma.TransactionClient,
  eventId: string,
): Promise<EventInviteAuthority> {
  const event = await client.event.findUnique({
    where: { id: eventId },
    select: {
      householdId: true,
      policy: { select: { allowMemberInvites: true } },
      attendees: { where: NOT_REMOVED, select: EVENT_ROSTER_SELECT },
    },
  });

  return {
    eventId,
    householdId: event?.householdId ?? null,
    allowMemberInvites: event?.policy?.allowMemberInvites ?? true,
    attendees: event?.attendees ?? [],
  };
}

/**
 * The roster the invite grants are asked about under the event policy, and
 * the one place that knows the rule (#742): with `allowMemberInvites` off,
 * the `EventParticipant` rows are left out. The participant arm of
 * `create:event_invite` then matches nobody, while a host, co-host or
 * organizer still matches their own arm, and a household owner or admin
 * holding `create:event_invite:household` reads no roster at all. So the
 * switch takes away only the inviting a participant has from their event
 * role, whatever else they hold.
 */
function rosterUnderPolicy({ allowMemberInvites, attendees }: EventInviteAuthority): readonly EventRosterRow[] {
  if (allowMemberInvites) {
    return attendees;
  }

  return attendees.filter((attendee) => attendee.role?.role.name !== SystemRole.EventParticipant);
}

function inviteSubjectOver(authority: EventInviteAuthority, attendees: readonly EventRosterRow[]) {
  return { eventId: authority.eventId, event: { householdId: authority.householdId, attendees: [...attendees] } };
}

/**
 * An invite to the event as the invite grants are asked about it (#742): the
 * event, its household and its roster under the event policy
 * ({@link rosterUnderPolicy}). Sending one and accepting one ask about the
 * same instance, so a grant reads the sender's standing the same way at
 * both, and the event's list and revoke ask about it too.
 */
export function eventInviteSubject(authority: EventInviteAuthority) {
  return inviteSubjectOver(authority, rosterUnderPolicy(authority));
}

/**
 * Whether the acting user may invite to this event, offering `role`, as the
 * caller read the event's `authority` under its lock (#742). Throws when not:
 *
 * 1. `create` on an invite to the event, asked of the whole roster: 403
 *    when no grant of theirs reaches it.
 * 2. For any role but participant, the grant the direct add asks for that
 *    role (`EventAttendeeService.addAttendee`): 403 without it, so a
 *    participant cannot hand out the co-host role by invite.
 * 3. The first question asked again of the roster under the event policy
 *    ({@link eventInviteSubject}). Failing only that means the actor's sole
 *    inviting grant is the participant role's, and `allowMemberInvites` is
 *    off: 403 coded `MEMBER_INVITES_OFF`, so a client can say why.
 *
 * The whole-roster subject lives here and nowhere else, so no other caller
 * can ask the grants about a roster the event policy did not shape.
 */
export function assertMayInvite(
  abilities: AbilityService,
  authority: EventInviteAuthority,
  role: AssignableAttendeeRole,
): void {
  abilities.assertCurrentActorCan(
    Action.create,
    ResourceType.Invite,
    inviteSubjectOver(authority, authority.attendees),
  );

  if (offersMoreThanParticipant(role)) {
    abilities.assertCurrentActorCan(Action.create, ResourceType.EventAttendee, eventAttendeeSubject(authority, role));
  }

  if (!abilities.currentActorCan(Action.create, ResourceType.Invite, eventInviteSubject(authority))) {
    throw new CodedHttpException(Http.Forbidden, 'MEMBER_INVITES_OFF', t('errors.event.member_invites_off'));
  }
}

/**
 * The attendee row an invite offering `role` would write once accepted, as
 * the direct add asks about it (`EventAttendeeService.addAttendee`): the
 * event, its household, and the role (#742). Offering a role other than
 * participant also needs the grant that gives that role out directly.
 */
export function eventAttendeeSubject(authority: EventInviteAuthority, role: AssignableAttendeeRole) {
  return { eventId: authority.eventId, event: { householdId: authority.householdId }, role: { role: { name: role } } };
}

/** Whether offering `role` needs more than an invite grant: every role but participant does (#742). */
export function offersMoreThanParticipant(role: AssignableAttendeeRole): boolean {
  return role !== SystemRole.EventParticipant;
}

/**
 * The event role an invite offers, as the accept seats it and the sender
 * check asks about it (#742). No role is participant, the role an invite
 * offers by default. The create stores only an assignable role, so another
 * is drift in the data: a server error, and nothing the invitee did.
 */
export function offeredAttendeeRole(invite: {
  readonly id: string;
  readonly role: { readonly name: string } | null;
}): AssignableAttendeeRole {
  const name = invite.role?.name;

  if (name === undefined) {
    return SystemRole.EventParticipant;
  }

  const role = ASSIGNABLE_ATTENDEE_ROLES.find((assignable) => assignable === name);

  if (role === undefined) {
    throw new Error(`Invite ${invite.id} offers the role '${name}', which no attendee can hold`);
  }

  return role;
}

/**
 * Whether an invite's sender could send it now (#742), asked of their own
 * ability as `tx` reads it, about the event's `authority` as the caller read
 * it under its event lock: their role on the roster and the event policy as
 * they stand now, not as they stood when they sent it. So an invite whose
 * sender has left the event, lost the role that let them invite, or invited
 * as a participant before `allowMemberInvites` was switched off admits
 * nobody. One offering a role other than participant also needs the grant
 * that gives that role out. The sender's graph is loaded once for both
 * questions.
 */
export async function senderCouldStillSend(
  abilities: AbilityService,
  tx: Prisma.TransactionClient,
  authority: EventInviteAuthority,
  sender: { readonly inviterId: string; readonly role: AssignableAttendeeRole },
): Promise<boolean> {
  const senderCan = await abilities.userAbilityWithin(tx, sender.inviterId);

  return (
    senderCan(Action.create, ResourceType.Invite, eventInviteSubject(authority)) &&
    (!offersMoreThanParticipant(sender.role) ||
      senderCan(Action.create, ResourceType.EventAttendee, eventAttendeeSubject(authority, sender.role)))
  );
}
