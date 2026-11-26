import { InviteType } from '@bge/database';
import type { InvitePartyRowWire, ReceivedInviteWire } from '../household/household-invite-wire';
import { inviteEnvelope, inviteListEnvelope } from '../household/household-invite-wire';
import type { PaginationWire } from '../household/household-wire';
import type { HttpResponseLike, RequestDescription } from '../support/wire';
import { envelopeFailure, isRecord } from '../support/wire';
import type { EventAttendeeWire } from './event-wire';

/**
 * Wire-contract types and fail-loud parsers for event invites on the party
 * routes under `/api/invites` (#742), on the model of the household ones in
 * `household-invite-wire.ts`, whose party shape they share.
 */

/** An event invite as its parties see it in a party list: the party shape, and the event it is to. */
export interface EventPartyInviteWire extends InvitePartyRowWire {
  readonly event: { readonly id: string; readonly title: string };
  readonly household: null;
  readonly type: typeof InviteType.Event;
}

/** A row of a party list: a household invite naming its household, or an event invite naming its event. */
export type PartyInviteRowWire = EventPartyInviteWire | ReceivedInviteWire;

export interface PartyInvitesEnvelope {
  readonly invites: readonly PartyInviteRowWire[];
  readonly pagination: PaginationWire;
}

/** The attendee row an accepted event invite seated, with the event role it holds. */
export type SeatedAttendeeWire = EventAttendeeWire & {
  readonly role: { readonly role: { readonly name: string } } | null;
};

export interface EventAcceptEnvelope {
  readonly attendee: SeatedAttendeeWire;
  readonly invite: InvitePartyRowWire;
  readonly message: string;
  readonly type: typeof InviteType.Event;
}

const fail = envelopeFailure('apps/api-e2e/src/event/event-invite-wire.ts');

function hasStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0;
}

/** Whether a listed row names the context its `type` has, and leaves the other `null`. */
function namesItsContext(row: Record<string, unknown>): boolean {
  if (row['type'] === InviteType.Event) {
    const event = row['event'];

    return hasStringId(event) && typeof event['title'] === 'string' && row['household'] === null;
  }

  return row['type'] === InviteType.Household && hasStringId(row['household']) && row['event'] === null;
}

/**
 * `GET /api/invites` and `GET /api/invites/sent` with both kinds in them:
 * `{ invites: [...], pagination }`, each row in the party shape, carrying its
 * `type` and the `household` or `event` it is into.
 */
export function partyInvitesEnvelope(response: HttpResponseLike, request: RequestDescription): PartyInvitesEnvelope {
  const { invites, pagination } = inviteListEnvelope(response, request);

  for (const invite of invites) {
    const row = invite as unknown as Record<string, unknown>;

    if (!namesItsContext(row) || !('inviteeEmail' in row) || !('message' in row)) {
      return fail(
        `its invite ${invite.id} lacked the context its type names, or the party shape's 'inviteeEmail' or 'message' key`,
        request,
        response,
      );
    }
  }

  return { invites: invites as unknown as PartyInviteRowWire[], pagination };
}

/**
 * `POST /api/invites/:inviteId/accept` for an event invite:
 * `{ message, type, invite, attendee }`. The attendee must name its event and
 * user, which are what a client joins on.
 */
export function eventAcceptEnvelope(response: HttpResponseLike, request: RequestDescription): EventAcceptEnvelope {
  const { message, invite } = inviteEnvelope(response, request);

  // Proved by the parse above; repeated because TypeScript cannot see it there.
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const attendee = response.body['attendee'];
  if (!hasStringId(attendee) || typeof attendee['eventId'] !== 'string' || typeof attendee['userId'] !== 'string') {
    return fail("it carried no 'attendee' object with string 'id', 'eventId' and 'userId'", request, response);
  }

  if (response.body['type'] !== InviteType.Event) {
    return fail(`its 'type' was not '${InviteType.Event}'`, request, response);
  }

  return { message, invite, attendee: attendee as unknown as SeatedAttendeeWire, type: InviteType.Event };
}
