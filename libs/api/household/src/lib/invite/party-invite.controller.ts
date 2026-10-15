import { ApiPaginatedEnvelope, DefaultPaginationQueryDto, paginated, Unscoped } from '@bge/shared';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { PartyInviteService } from './party-invite.service';

/** The third case `UnscopedList` documents: bound by a rule of its own, with no ceiling to compose. */
const RECEIVED_INVITES_SCOPE = Unscoped(
  "bound to the acting user in its own query by the invites lib's party rule (receivedInviteWhere); an invitee " +
    'holds no grant on Invite, so no ability covers these rows, and every actor but a session user is refused ' +
    'before the read, so no delegated ceiling is dropped',
);

// The actions a party takes on an invite of theirs, beside the household's own
// routes under `/households/:householdId/invites`, as the invites lib splits a
// party's primitives from a context authority's. #164 adds decline and
// withdraw here.
//
// No API key: joining a household is the joiner's own act (#276), so the
// service refuses every actor but a session user (403).
//
// Must stay out of the response cache: the inbox has to reflect the invites
// as they stand, and a cache hit would skip the service, where the caller is
// bound (#528).
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
}
