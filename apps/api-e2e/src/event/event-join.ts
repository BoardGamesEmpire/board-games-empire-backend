import { SystemRole } from '@bge/database';
import type { AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { inviteEnvelope } from '../household/household-invite-wire';
import { eventAcceptEnvelope } from './event-invite-wire';
import { EVENTS_PATH } from './event-request';

/**
 * The event roles an invite may offer: every event role but `EventHost`, which
 * belongs to whoever created the event. The API's own list is
 * `ASSIGNABLE_ATTENDEE_ROLES` in `@bge/event`, which this app does not import.
 */
export type AssignableAttendeeRole =
  | typeof SystemRole.EventParticipant
  | typeof SystemRole.EventGuest
  | typeof SystemRole.EventSpectator
  | typeof SystemRole.EventCoHost
  | typeof SystemRole.EventOrganizer
  | typeof SystemRole.EventModerator;

/**
 * Makes `invitee` an attendee of the event the way a person with an account
 * joins one (#742): `inviter` invites them, offering `role`, and they accept.
 * Accepting writes their attendee row `Attending`, in the offered role, and
 * evicts their cached graph, so the role reaches their next request.
 *
 * Fails the test unless the invite answers 201 and the accept 200. Answers
 * the attendee row the accept wrote.
 */
export async function inviteAndAccept(
  baseUrl: string,
  inviter: AuthenticatedActor,
  invitee: AuthenticatedActor,
  eventId: string,
  role: AssignableAttendeeRole = SystemRole.EventParticipant,
): Promise<{ attendeeId: string }> {
  const { invite } = inviteEnvelope(
    await request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/invites`)
      .set(inviter.headers)
      .send({ userId: invitee.user.id, role })
      .expect(201),
    'POST /api/events/:eventId/invites',
  );

  const { attendee } = eventAcceptEnvelope(
    await request(baseUrl).post(`/api/invites/${invite.id}/accept`).set(invitee.headers).expect(200),
    'POST /api/invites/:inviteId/accept',
  );

  return { attendeeId: attendee.id };
}
