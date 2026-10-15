import { t } from '@bge/i18n';
import { ApiPaginatedEnvelope, DefaultPaginationQueryDto, paginated, Unscoped } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { AcceptInviteByTokenDto } from '../dto';
import { PartyInviteService, type HouseholdInviteAcceptance } from './party-invite.service';

/** The third case `UnscopedList` documents: bound by a rule of its own, with no ceiling to compose. */
const RECEIVED_INVITES_SCOPE = Unscoped(
  "bound to the acting user in its own query by the invites lib's party rule (receivedInviteWhere); an invitee " +
    'holds no grant on Invite, so no ability covers these rows, and every actor but a session user is refused ' +
    'before the read, so no delegated ceiling is dropped',
);

const ACCEPTED_DESCRIPTION =
  'Joined: `{ message, invite, member }`, where `member` is the new membership, with the role the invite offered.';

const ACCEPT_CONFLICT_DESCRIPTION =
  'Already a member of the household, in which case the invite stays open; or the invite was settled, is still ' +
  'awaiting approval, or changed while it was being accepted';

/** Both accept routes answer alike, whichever way the invite was named. */
function acceptedResponse({ invite, member }: HouseholdInviteAcceptance) {
  return { message: t('success.household.invite_accepted'), invite, member };
}

// The actions a party takes on an invite of theirs, beside the household's own
// routes under `/households/:householdId/invites`, as the invites lib splits a
// party's primitives from a context authority's. #164 adds decline and
// withdraw here.
//
// No API key: joining a household is the joiner's own act (#276), so the
// service refuses every actor but a session user (403).
//
// Must stay out of the response cache: the inbox has to drop an invite the
// caller just accepted, and a cache hit would skip the service, where the
// caller is bound (#528).
@ApiBearerAuth()
@ApiTags('invites')
@Controller('invites')
export class PartyInviteController {
  constructor(private readonly partyInvites: PartyInviteService) {}

  @ApiOperation({
    summary: 'List the household invites you have received',
    description:
      'The invites still open to you: sent to your user id, or to your email address once it is verified; ' +
      '`Pending`, or `AwaitingApproval` until an approver opens it to you, and not expired; into a household that ' +
      'exists and that you are not already in. Newest first. Each carries the household that sent it, the role it ' +
      'offers, the inviter, and the message. Paginated: `?page=` (1-based) and `?limit=`, with a `pagination` ' +
      'envelope carrying `total`, `totalPages` and `hasMore`. See #230.',
  })
  @ApiPaginatedEnvelope('invites')
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a signed-in user: API keys cannot read an inbox' })
  @Get()
  listReceived(@Query() query: DefaultPaginationQueryDto) {
    return from(this.partyInvites.listReceived(query)).pipe(
      map((page) => paginated('invites', page, query, RECEIVED_INVITES_SCOPE)),
    );
  }

  @ApiOperation({
    summary: 'Accept a household invite by the token from its link',
    description:
      'The token goes in the body, never the URL. Whoever holds the link joins, whatever their address, so ' +
      'treat it as a password. No email carries links yet (#173).',
  })
  @ApiResponse({ status: Http.Ok, description: ACCEPTED_DESCRIPTION })
  @ApiResponse({ status: Http.BadRequest, description: 'No token given' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.PaymentRequired, description: 'The household is at its member cap (#288)' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Your own invite, or not a signed-in user: API keys cannot join a household',
  })
  @ApiResponse({ status: Http.NotFound, description: 'No invite matches the link, or its household is gone' })
  @ApiResponse({ status: Http.Conflict, description: ACCEPT_CONFLICT_DESCRIPTION })
  @ApiResponse({ status: Http.Gone, description: 'The invite has expired' })
  @HttpCode(Http.Ok)
  @Post('accept')
  acceptByToken(@Body() dto: AcceptInviteByTokenDto) {
    return from(this.partyInvites.accept({ token: dto.token })).pipe(map(acceptedResponse));
  }

  @ApiOperation({
    summary: 'Accept a household invite you have received',
    description:
      'An invite sent to your user id, or to your email address once it is verified. Accepting one you could ' +
      'not reach is a 404, so the answer never confirms that someone else’s invite exists.',
  })
  @ApiParam({ name: 'inviteId', type: String })
  @ApiResponse({ status: Http.Ok, description: ACCEPTED_DESCRIPTION })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.PaymentRequired, description: 'The household is at its member cap (#288)' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Your own invite, or not a signed-in user: API keys cannot join a household',
  })
  @ApiResponse({ status: Http.NotFound, description: 'No invite of yours has that id, or its household is gone' })
  @ApiResponse({ status: Http.Conflict, description: ACCEPT_CONFLICT_DESCRIPTION })
  @ApiResponse({ status: Http.Gone, description: 'The invite has expired' })
  @HttpCode(Http.Ok)
  @Post(':inviteId/accept')
  accept(@Param('inviteId') inviteId: string) {
    return from(this.partyInvites.accept({ inviteId })).pipe(map(acceptedResponse));
  }
}
