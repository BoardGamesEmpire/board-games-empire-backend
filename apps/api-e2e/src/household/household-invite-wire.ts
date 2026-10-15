import type { Invite } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';
import { asPagination, type PaginationWire, type PendingInviteProjection } from './household-wire';

/**
 * Wire-contract types and fail-loud parsers for the household invite routes
 * (#162), on the model of `household-wire.ts`.
 *
 * Two shapes reach a client. Every row carries the context shape, which is the
 * household detail's invite embed. A row the caller sent carries the party
 * shape: the context shape plus the address and the message they wrote. The
 * invitee's routes (#163) answer in the party shape too, and their inbox adds
 * the household that sent each invite.
 */

/** The two columns only a party sees. */
export type InvitePartyFieldsWire = Wire<Pick<Invite, 'inviteeEmail' | 'message'>>;

/** An invite as its inviter sees it: what `POST` answers, and a listed row the caller sent. */
export interface InvitePartyRowWire extends PendingInviteProjection, InvitePartyFieldsWire {}

/** A listed row: the party shape on the caller's own rows, the context shape on the rest. */
export type ListedInviteWire = PendingInviteProjection | InvitePartyRowWire;

export interface CreateInviteEnvelope {
  readonly message: string;
  readonly invite: InvitePartyRowWire;
}

export interface ListInvitesEnvelope {
  readonly invites: readonly ListedInviteWire[];
  readonly pagination: PaginationWire;
}

const fail = envelopeFailure('apps/api-e2e/src/household/household-invite-wire.ts');

function hasStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0;
}

/**
 * `POST /api/households/:householdId/invites`: `{ message, invite }`.
 *
 * Both party columns must be PRESENT, as a value or `null`: a missing key
 * would make an assertion that the address is null pass against `undefined`.
 */
export function inviteEnvelope(response: HttpResponseLike, request: RequestDescription): CreateInviteEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const invite = response.body['invite'];
  if (!hasStringId(invite)) {
    return fail("it carried no 'invite' object with a string id", request, response);
  }

  if (!('inviteeEmail' in invite) || !('message' in invite)) {
    return fail("its invite lacked the party shape's 'inviteeEmail' or 'message' key", request, response);
  }

  const message = response.body['message'];
  if (typeof message !== 'string') {
    return fail("it carried no 'message' string", request, response);
  }

  return { message, invite: invite as unknown as InvitePartyRowWire };
}

/** `GET /api/households/:householdId/invites`: `{ invites: [...], pagination }`. */
export function inviteListEnvelope(response: HttpResponseLike, request: RequestDescription): ListInvitesEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const invites = response.body['invites'];
  if (!Array.isArray(invites) || !invites.every(hasStringId)) {
    return fail("it carried no 'invites' array of objects with string ids", request, response);
  }

  const pagination = asPagination(response.body['pagination']);
  if (pagination === undefined) {
    return fail("it carried no consistent 'pagination' envelope", request, response);
  }

  if (invites.length > pagination.limit || invites.length > pagination.total) {
    return fail(`it carried ${invites.length} invites, more than its pagination admits`, request, response);
  }

  return { invites: invites as unknown as ListedInviteWire[], pagination };
}

/** An invite as its invitee sees it in their inbox: the party shape and the household asking (#163). */
export interface ReceivedInviteWire extends InvitePartyRowWire {
  readonly household: { readonly id: string; readonly name: string };
}

export interface ReceivedInvitesEnvelope {
  readonly invites: readonly ReceivedInviteWire[];
  readonly pagination: PaginationWire;
}

/** `GET /api/invites`: `{ invites: [...], pagination }`, each row naming its household. */
export function receivedInvitesEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): ReceivedInvitesEnvelope {
  const { invites, pagination } = inviteListEnvelope(response, request);

  for (const invite of invites) {
    const row = invite as unknown as Record<string, unknown>;

    if (!hasStringId(row['household']) || !('inviteeEmail' in row) || !('message' in row)) {
      return fail(
        `its invite ${invite.id} lacked the 'household' object or the party shape's 'inviteeEmail' or 'message' key`,
        request,
        response,
      );
    }
  }

  return { invites: invites as unknown as ReceivedInviteWire[], pagination };
}
