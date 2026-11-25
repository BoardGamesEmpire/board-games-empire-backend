import { SystemRole } from '@bge/database';
import type { AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import type { InvitePartyRowWire } from '../household/household-invite-wire';
import { inviteEnvelope } from '../household/household-invite-wire';
import type { Caller } from '../support/api-key';
import type { EventAcceptEnvelope } from './event-invite-wire';
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

/** `/api/events/:eventId/invites`: where an event's invites are sent and listed (#742). */
const eventInvitesPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/invites`;

/** `/api/invites`: where a party answers an invite of every kind (#742). */
export const PARTY_INVITES_PATH = '/api/invites';

/**
 * Request construction for event invites (#742), shared by the event e2e
 * specs, which had each grown their own copies. Each method sends as
 * `caller`, a session or a key, and returns the supertest chain, so callers
 * keep `.expect()`, except the two that parse a success.
 */
export interface EventInviteClient {
  /** `POST /api/invites/:inviteId/accept`. */
  accept(caller: Caller, inviteId: string): request.Test;

  /** The acceptance an event invite answers with, failing the test unless the accept answers 200. */
  accepted(caller: Caller, inviteId: string): Promise<EventAcceptEnvelope>;

  /** `POST /api/invites/:inviteId/decline`. */
  decline(caller: Caller, inviteId: string): request.Test;

  /** `POST /api/events/:eventId/invites` with `body` as sent. */
  invite(caller: Caller, eventId: string, body: Record<string, unknown>): request.Test;

  /** `GET /api/events/:eventId/invites`, with `query` as sent. */
  listInvites(caller: Caller, eventId: string, query?: Record<string, string>): request.Test;

  /** `POST /api/events/:eventId/invites/:inviteId/revoke`. */
  revoke(caller: Caller, eventId: string, inviteId: string): request.Test;

  /** The invite `caller` sends, failing the test unless the invite answers 201. */
  sentInvite(caller: Caller, eventId: string, body: Record<string, unknown>): Promise<InvitePartyRowWire>;

  /** `POST /api/invites/:inviteId/withdraw`. */
  withdraw(caller: Caller, inviteId: string): request.Test;
}

export function createEventInviteClient(baseUrl: string): EventInviteClient {
  const invite = (caller: Caller, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(eventInvitesPath(eventId)).set(caller.headers).send(body);

  const accept = (caller: Caller, inviteId: string) =>
    request(baseUrl).post(`${PARTY_INVITES_PATH}/${inviteId}/accept`).set(caller.headers);

  return {
    invite,
    sentInvite: async (caller, eventId, body) =>
      inviteEnvelope(await invite(caller, eventId, body).expect(201), 'POST /api/events/:eventId/invites').invite,
    listInvites: (caller, eventId, query = {}) =>
      request(baseUrl).get(eventInvitesPath(eventId)).query(query).set(caller.headers),
    revoke: (caller, eventId, inviteId) =>
      request(baseUrl)
        .post(`${eventInvitesPath(eventId)}/${inviteId}/revoke`)
        .set(caller.headers),
    accept,
    accepted: async (caller, inviteId) =>
      eventAcceptEnvelope(await accept(caller, inviteId).expect(200), 'POST /api/invites/:inviteId/accept'),
    decline: (caller, inviteId) =>
      request(baseUrl).post(`${PARTY_INVITES_PATH}/${inviteId}/decline`).set(caller.headers),
    withdraw: (caller, inviteId) =>
      request(baseUrl).post(`${PARTY_INVITES_PATH}/${inviteId}/withdraw`).set(caller.headers),
  };
}

/**
 * Makes `invitee` an attendee of the event the way a registered user
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
  const { sentInvite, accepted } = createEventInviteClient(baseUrl);
  const invite = await sentInvite(inviter, eventId, { userId: invitee.user.id, role });
  const { attendee } = await accepted(invitee, invite.id);

  return { attendeeId: attendee.id };
}
