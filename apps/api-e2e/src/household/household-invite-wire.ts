import type { HouseholdBan, Invite } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';
import {
  asPagination,
  type ActorProjection,
  type HouseholdMemberProjection,
  type HouseholdRoleProjection,
  type PaginationWire,
} from './household-wire';

/**
 * Wire-contract types and fail-loud parsers for the household invite routes
 * (#162), on the model of `household-wire.ts`.
 *
 * Three shapes reach a client. Every row carries the context shape. A row the
 * caller sent carries the party shape: the context shape plus the address and
 * the message they wrote. Any other row carries the authority shape for the
 * household's owners and admins (#167): the context shape plus the address
 * alone. The invitee's routes (#163) answer in the party shape too, and their
 * inbox adds the household that sent each invite.
 */

/**
 * An invite as a context reader gets it (`CONTEXT_INVITE_SELECT`), which is far
 * narrower than the model.
 *
 * This shape publishes six of `Invite`'s scalars. The ledgers in the invites
 * lib's `read-shapes.ts` give the reason each other one is withheld, and two
 * of them are the whole of #297: `token` is a live accept credential, and
 * `inviteeEmail` is an address belonging to someone who may have no account.
 * Declaring either here would let an assertion on it typecheck and then pass
 * vacuously against `undefined`.
 *
 * `Pick` rather than `Omit`, for the reason on `HouseholdMemberWire` in
 * `household-wire.ts`: dropping or renaming a published column is a compile
 * error at this declaration, while `Omit` would accept a key the model no
 * longer carries and silently omit nothing.
 */
export type ContextInviteWire = Wire<
  Pick<Invite, 'id' | 'status' | 'type' | 'inviteeName' | 'expiresAt' | 'createdAt'>
>;

/** A context invite with the `role` and `inviter` embeds, as #297 shapes it. */
export interface ContextInviteProjection extends ContextInviteWire {
  readonly role: HouseholdRoleProjection['role'] | null;
  readonly inviter: ActorProjection;
}

/** The two columns the party shape adds; the authority shape adds the address alone (#167). */
export type InvitePartyFieldsWire = Wire<Pick<Invite, 'inviteeEmail' | 'message'>>;

/** An invite as its inviter sees it: what `POST` answers, and a listed row the caller sent. */
export interface InvitePartyRowWire extends ContextInviteProjection, InvitePartyFieldsWire {}

/** An invite as the household's owners and admins see one they did not send (#167): the address, not the message. */
export interface InviteAuthorityRowWire extends ContextInviteProjection, Wire<Pick<Invite, 'inviteeEmail'>> {}

/**
 * A listed row: the party shape on the caller's own rows; the authority shape
 * on the rest for the household's owners and admins, the context shape for
 * anyone else.
 */
export type ListedInviteWire = ContextInviteProjection | InviteAuthorityRowWire | InvitePartyRowWire;

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
 * `POST /api/households/:householdId/invites`: `{ message, invite }`. Also the
 * answer to a decline and a withdraw (#164), which a party makes.
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

export interface RevokeInviteEnvelope {
  readonly message: string;
  readonly invite: ContextInviteProjection | InviteAuthorityRowWire;
}

/**
 * `POST /api/households/:householdId/invites/:inviteId/revoke`: `{ message, invite }`
 * (#164), in the authority shape for the household's owners and admins (#167)
 * and the context shape for anyone else. A revoker is not a party, so the
 * caller asserts the message is absent; this checks only what a client joins on.
 */
export function revokeEnvelope(response: HttpResponseLike, request: RequestDescription): RevokeInviteEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const invite = response.body['invite'];
  if (!hasStringId(invite) || typeof invite['status'] !== 'string') {
    return fail("it carried no 'invite' object with a string id and status", request, response);
  }

  const message = response.body['message'];
  if (typeof message !== 'string') {
    return fail("it carried no 'message' string", request, response);
  }

  return { message, invite: invite as unknown as RevokeInviteEnvelope['invite'] };
}

/**
 * `POST /api/households/:householdId/invites/:inviteId/approve`: `{ message, invite }`
 * (#166), in the shape a revoke answers in. An approver is not a party either.
 */
export const approveEnvelope = revokeEnvelope;

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

export interface AcceptInviteEnvelope {
  readonly message: string;
  readonly invite: InvitePartyRowWire;
  readonly member: HouseholdMemberProjection;
}

/**
 * `POST /api/invites/:inviteId/accept` and `POST /api/invites/accept`:
 * `{ message, invite, member }`. The member must name its household and
 * user, which are what a client joins on.
 */
export function acceptEnvelope(response: HttpResponseLike, request: RequestDescription): AcceptInviteEnvelope {
  const { message, invite } = inviteEnvelope(response, request);

  // Proved by the parse above; repeated because TypeScript cannot see it there.
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const member = response.body['member'];
  if (!hasStringId(member) || typeof member['householdId'] !== 'string' || typeof member['userId'] !== 'string') {
    return fail("it carried no 'member' object with string 'id', 'householdId' and 'userId'", request, response);
  }

  return { message, invite, member: member as unknown as HouseholdMemberProjection };
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

/**
 * `GET /api/invites/sent` (#751): the inbox's shape, each row the party shape
 * and the household it is into.
 */
export const sentInvitesEnvelope = receivedInvitesEnvelope;

/** Someone a household ban names (#782): by id, and as they are shown. */
export interface BanPartyWire {
  readonly id: string;
  readonly name: string;
}

/**
 * A household ban as its owners and admins get it (#782). `Pick` for the
 * reason `ContextInviteWire` gives.
 */
export interface HouseholdBanWire extends Wire<
  Pick<HouseholdBan, 'id' | 'householdId' | 'reason' | 'createdAt' | 'updatedAt'>
> {
  readonly user: BanPartyWire;
  readonly bannedBy: BanPartyWire | null;
}

export interface BanEnvelope {
  readonly message: string;
  readonly ban: HouseholdBanWire;
}

export interface BansPage {
  readonly bans: readonly HouseholdBanWire[];
  readonly pagination: PaginationWire;
}

function isBanParty(value: unknown): value is BanPartyWire {
  return hasStringId(value) && typeof value['name'] === 'string';
}

/**
 * Whether `value` is a ban with every key a client reads. `reason` and
 * `bannedBy` must be PRESENT, as a value or `null`, for the reason
 * {@link inviteEnvelope} gives.
 */
function isBan(value: unknown): value is HouseholdBanWire {
  return (
    hasStringId(value) &&
    typeof value['householdId'] === 'string' &&
    'reason' in value &&
    isBanParty(value['user']) &&
    'bannedBy' in value &&
    (value['bannedBy'] === null || isBanParty(value['bannedBy']))
  );
}

/**
 * `POST /api/households/:householdId/bans`, and `PATCH` and `DELETE`
 * `…/bans/:userId` (#782): `{ message, ban }`.
 */
export function banEnvelope(response: HttpResponseLike, request: RequestDescription): BanEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const ban = response.body['ban'];
  if (!isBan(ban)) {
    return fail(
      "it carried no 'ban' with a string id, householdId, user, and a reason and bannedBy",
      request,
      response,
    );
  }

  const message = response.body['message'];
  if (typeof message !== 'string') {
    return fail("it carried no 'message' string", request, response);
  }

  return { message, ban };
}

/** `GET /api/households/:householdId/bans` (#782): `{ bans: [...], pagination }`. */
export function bansPage(response: HttpResponseLike, request: RequestDescription): BansPage {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const bans = response.body['bans'];
  if (!Array.isArray(bans) || !bans.every(isBan)) {
    return fail("it carried no 'bans' array of bans", request, response);
  }

  const pagination = asPagination(response.body['pagination']);
  if (pagination === undefined) {
    return fail("it carried no consistent 'pagination' envelope", request, response);
  }

  if (bans.length > pagination.limit || bans.length > pagination.total) {
    return fail(`it carried ${bans.length} bans, more than its pagination admits`, request, response);
  }

  return { bans, pagination };
}
