import { InviteType } from '@bge/database';
import type { I18nMessage } from '@bge/i18n';
import { t } from '@bge/i18n';
import type { ContextualInviteType, InvitePartyView } from '@bge/invites';
import { isContextualInviteType } from '@bge/invites';
import { ApiPaginatedEnvelope, paginated, Unscoped } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  InviteTokenDto,
  ListReceivedInvitesQueryDto,
  ListSentInvitesQueryDto,
  PARTY_INVITE_TYPE_DESCRIPTION,
} from './dto';
import type { PartyAcceptance } from './party-invite.service';
import { PartyInviteService } from './party-invite.service';

/** The third case `UnscopedList` documents: bound by a rule of its own, with no ceiling to compose. */
const RECEIVED_INVITES_SCOPE = Unscoped(
  "bound to the acting user in its own query by the invites lib's party rule (receivedInviteWhere); an invitee " +
    'holds no grant on Invite, so no ability covers these rows, and every actor but a session user is refused ' +
    'before the read, so no delegated ceiling is dropped',
);

/** As the inbox, bound by the other party: the inviter, whom the query names by `inviterId`. */
const SENT_INVITES_SCOPE = Unscoped(
  'bound to the acting user in its own query as the inviter (inviterId); an inviter holds no grant on Invite, ' +
    'so no ability covers these rows, and every actor but a session user is refused before the read, so no ' +
    'delegated ceiling is dropped',
);

const PAGINATION_DESCRIPTION =
  'Paginated: `?page=` (1-based) and `?limit=`, with a `pagination` envelope carrying `total`, `totalPages` and ' +
  '`hasMore`. See #230.';

const ACCEPTED_DESCRIPTION =
  'Accepted: `{ message, type, invite, ... }`, where `type` is the kind of invite. For a household invite, ' +
  '`member` is the new household membership, with the role the invite offered. For an event invite, ' +
  '`attendee` is your attendee row, `Attending`, with the role the invite offered. Its `availableGames` is read ' +
  'under the access you had before the accept, so it reads empty until your next request.';

const ACCEPT_CONFLICT_DESCRIPTION =
  'Already in the household, or already attending the event, the invite is into, in which case the invite stays ' +
  'open; or the invite was settled, has expired, is still awaiting approval, or changed while it was being ' +
  'accepted. An invite whose inviter can no longer send it is revoked, and answers as a revoked invite.';

const ACCEPT_FORBIDDEN_DESCRIPTION = 'Your own invite, or not a signed-in user: API keys cannot accept an invite';

const DECLINED_DESCRIPTION = 'Declined: `{ message, invite }`, the invite as you see it, now `Declined`.';

const DECLINE_FORBIDDEN_DESCRIPTION = 'Your own invite, or not a signed-in user: API keys cannot decline an invite';

const SETTLED_CONFLICT_DESCRIPTION =
  'The invite was already settled, has expired, or changed while it was being answered';

/**
 * How a decline and a withdraw are worded, for each kind of invite the party
 * routes serve (#742). A kind added to them fails to compile here until it
 * has its own copy.
 */
const SETTLED_COPY = {
  [InviteType.Household]: {
    declined: () => t('success.household.invite_declined'),
    withdrawn: () => t('success.household.invite_withdrawn'),
  },
  [InviteType.Event]: {
    declined: () => t('success.event.invite_declined'),
    withdrawn: () => t('success.event.invite_withdrawn'),
  },
} as const satisfies Record<ContextualInviteType, Record<'declined' | 'withdrawn', () => I18nMessage>>;

/**
 * The copy for an invite a party route answered, by its kind. Only a kind the
 * party routes serve gets an answer: the type read refuses every other kind
 * with the 404 a stranger meets, before any responder is asked.
 */
function settledCopyOf(invite: InvitePartyView): (typeof SETTLED_COPY)[ContextualInviteType] {
  if (!isContextualInviteType(invite.type)) {
    throw new Error(`Invite ${invite.id} is a ${invite.type} invite, which no party route answers`);
  }

  return SETTLED_COPY[invite.type];
}

/**
 * Both accept routes answer alike, whichever way the invite was named: worded
 * for its kind, and carrying what its context made of it (#742).
 */
function acceptedResponse(acceptance: PartyAcceptance) {
  switch (acceptance.type) {
    case InviteType.Household: {
      const { type, invite, member } = acceptance;

      return { message: t('success.household.invite_accepted'), type, invite, member };
    }

    case InviteType.Event: {
      const { type, invite, attendee } = acceptance;

      return { message: t('success.event.invite_accepted'), type, invite, attendee };
    }
  }
}

/** Both decline routes answer alike, whichever way the invite was named. */
function declinedResponse(invite: InvitePartyView) {
  return { message: settledCopyOf(invite).declined(), invite };
}

// The actions a party takes on an invite of theirs, of every kind, beside each
// context's own routes (`/households/:householdId/invites`,
// `/events/:eventId/invites`), as the invites
// lib splits a party's primitives from a context authority's: the invitee
// lists, accepts or declines, and the inviter lists (#751) and withdraws. The
// route is the same for every kind; the service reads the invite's type and
// hands it to that kind's responder (#742). Withdraw is not revoke, which is a
// context's route for an invite someone else sent (#164).
//
// No API key: accepting, turning down or taking back an invite is the
// person's own act (#276), so the service refuses every actor but a session
// user (403).
//
// Must stay out of the response cache: the inbox has to drop an invite the
// caller just accepted or declined, and a cache hit would skip the service,
// where the caller is bound (#528).
@ApiBearerAuth()
@ApiTags('invites')
@Controller('invites')
export class PartyInviteController {
  constructor(private readonly partyInvites: PartyInviteService) {}

  @ApiOperation({
    summary: 'List the invites you have received',
    description:
      'The invites still open to you: sent to your user id, or to your email address once it is verified; ' +
      '`Pending` and not expired. A household invite is listed while its household exists and you are not ' +
      'already in it; one that waits for a household owner or household admin to approve it is not listed ' +
      'until it is approved. An event invite, sent to your user id, is listed while its event exists and you ' +
      "don't attend it. Newest first. Each carries the role it offers, the inviter, the message, and the " +
      '`household` or `event` it is into. ' +
      `${PARTY_INVITE_TYPE_DESCRIPTION} ${PAGINATION_DESCRIPTION}`,
  })
  @ApiPaginatedEnvelope('invites')
  @ApiResponse({ status: Http.BadRequest, description: 'A `?type=` no party route serves' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a signed-in user: API keys cannot read an inbox' })
  @Get()
  listReceived(@Query() query: ListReceivedInvitesQueryDto) {
    return from(this.partyInvites.listReceived(query)).pipe(
      map((page) => paginated('invites', page, query, RECEIVED_INVITES_SCOPE)),
    );
  }

  @ApiOperation({
    summary: 'List the invites you have sent',
    description:
      'By default, the invites still open, `Pending` or `AwaitingApproval`, and those that expired, so you can ' +
      'send another. `?status=` picks any status, judged as it stands now, so an outstanding invite past its ' +
      'expiry is `Expired`. Into a household you have left or been removed from, or to an event you no longer ' +
      'attend, only the invites you can still withdraw are listed, whatever the filter; none into a household or ' +
      'to an event that was deleted. Newest first. Each carries the role it offers, the address and the message ' +
      'you wrote, and the `household` or `event` it is into. ' +
      `${PARTY_INVITE_TYPE_DESCRIPTION} ${PAGINATION_DESCRIPTION}`,
  })
  @ApiPaginatedEnvelope('invites')
  @ApiResponse({ status: Http.BadRequest, description: 'A `?type=` no party route serves, or an unknown `?status=`' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a signed-in user: API keys cannot read your invites' })
  @Get('sent')
  listSent(@Query() query: ListSentInvitesQueryDto) {
    return from(this.partyInvites.listSent(query)).pipe(
      map((page) => paginated('invites', page, query, SENT_INVITES_SCOPE)),
    );
  }

  @ApiOperation({
    summary: 'Accept an invite by the token from its link',
    description:
      'The token goes in the body, never the URL. Whoever holds the link accepts, whatever their address, so ' +
      'treat it as a password. No email carries links yet (#173).',
  })
  @ApiResponse({ status: Http.Ok, description: ACCEPTED_DESCRIPTION })
  @ApiResponse({ status: Http.BadRequest, description: 'No token given' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.PaymentRequired, description: 'The household is at its member cap (#288)' })
  @ApiResponse({ status: Http.Forbidden, description: ACCEPT_FORBIDDEN_DESCRIPTION })
  @ApiResponse({ status: Http.NotFound, description: 'No invite matches the link, or its context is gone' })
  @ApiResponse({ status: Http.Conflict, description: ACCEPT_CONFLICT_DESCRIPTION })
  @HttpCode(Http.Ok)
  @Post('accept')
  acceptByToken(@Body() dto: InviteTokenDto) {
    return from(this.partyInvites.accept({ token: dto.token })).pipe(map(acceptedResponse));
  }

  @ApiOperation({
    summary: 'Accept an invite you have received',
    description:
      'An invite sent to your user id, or to your email address once it is verified. Accepting one you could ' +
      'not reach is a 404, so the answer never confirms that someone else’s invite exists.',
  })
  @ApiParam({ name: 'inviteId', type: String })
  @ApiResponse({ status: Http.Ok, description: ACCEPTED_DESCRIPTION })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.PaymentRequired, description: 'The household is at its member cap (#288)' })
  @ApiResponse({ status: Http.Forbidden, description: ACCEPT_FORBIDDEN_DESCRIPTION })
  @ApiResponse({ status: Http.NotFound, description: 'No invite of yours has that id, or its context is gone' })
  @ApiResponse({ status: Http.Conflict, description: ACCEPT_CONFLICT_DESCRIPTION })
  @HttpCode(Http.Ok)
  @Post(':inviteId/accept')
  accept(@Param('inviteId') inviteId: string) {
    return from(this.partyInvites.accept({ inviteId })).pipe(map(acceptedResponse));
  }

  @ApiOperation({
    summary: 'Decline an invite by the token from its link',
    description:
      'The token goes in the body, never the URL. An invite awaiting approval can be declined too: a refusal ' +
      'never waits on an approver.',
  })
  @ApiResponse({ status: Http.Ok, description: DECLINED_DESCRIPTION })
  @ApiResponse({ status: Http.BadRequest, description: 'No token given' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: DECLINE_FORBIDDEN_DESCRIPTION })
  @ApiResponse({ status: Http.NotFound, description: 'No invite matches the link' })
  @ApiResponse({ status: Http.Conflict, description: SETTLED_CONFLICT_DESCRIPTION })
  @HttpCode(Http.Ok)
  @Post('decline')
  declineByToken(@Body() dto: InviteTokenDto) {
    return from(this.partyInvites.decline({ token: dto.token })).pipe(map(declinedResponse));
  }

  @ApiOperation({
    summary: 'Decline an invite you have received',
    description:
      'An invite sent to your user id, or to your email address once it is verified. An invite awaiting ' +
      'approval can be declined too. Declining one you could not reach is a 404, so the answer never confirms ' +
      'that someone else’s invite exists.',
  })
  @ApiParam({ name: 'inviteId', type: String })
  @ApiResponse({ status: Http.Ok, description: DECLINED_DESCRIPTION })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: DECLINE_FORBIDDEN_DESCRIPTION })
  @ApiResponse({ status: Http.NotFound, description: 'No invite of yours has that id' })
  @ApiResponse({ status: Http.Conflict, description: SETTLED_CONFLICT_DESCRIPTION })
  @HttpCode(Http.Ok)
  @Post(':inviteId/decline')
  decline(@Param('inviteId') inviteId: string) {
    return from(this.partyInvites.decline({ inviteId })).pipe(map(declinedResponse));
  }

  @ApiOperation({
    summary: 'Withdraw an invite you sent',
    description:
      'Takes back an invite you sent, pending or awaiting approval, whatever your role in its context is now. ' +
      'To cancel a household invite someone else sent, a household owner or household admin revokes it: ' +
      '`POST /households/:householdId/invites/:inviteId/revoke`; for an event invite, the host or a co-host, ' +
      "or for a household's event an owner or admin of that household: " +
      '`POST /events/:eventId/invites/:inviteId/revoke`.',
  })
  @ApiParam({ name: 'inviteId', type: String })
  @ApiResponse({
    status: Http.Ok,
    description: 'Withdrawn: `{ message, invite }`, the invite as you see it, now `Withdrawn`.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'You received this invite rather than sent it, or not a signed-in user: API keys cannot withdraw',
  })
  @ApiResponse({ status: Http.NotFound, description: 'No invite of yours has that id' })
  @ApiResponse({ status: Http.Conflict, description: SETTLED_CONFLICT_DESCRIPTION })
  @HttpCode(Http.Ok)
  @Post(':inviteId/withdraw')
  withdraw(@Param('inviteId') inviteId: string) {
    return from(this.partyInvites.withdraw(inviteId)).pipe(
      map((invite) => ({ message: settledCopyOf(invite).withdrawn(), invite })),
    );
  }
}
