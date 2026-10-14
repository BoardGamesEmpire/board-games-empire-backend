import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, paginated } from '@bge/shared';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CreateHouseholdInviteDto, ListHouseholdInvitesQueryDto } from '../dto';
import { HouseholdLivenessGuard, HouseholdPathParam } from '../guards/household-liveness.guard';
import { HouseholdInviteService } from './household-invite.service';

// Must stay out of the response cache, for the reasons on
// `HouseholdController`: the list must reflect the invite its caller just
// sent, and a cache hit skips the service, where the household is authorized
// (#528).
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('household-invites')
// Liveness first, as on `HouseholdController` (#299): a missing or deleted
// household is 404 whatever the actor holds elsewhere.
@HouseholdPathParam('householdId')
@UseGuards(HouseholdLivenessGuard, PoliciesGuard)
@Controller('households/:householdId/invites')
export class HouseholdInviteController {
  constructor(private readonly inviteService: HouseholdInviteService) {}

  // The type-only check below passes any holder of `create:event_invite`;
  // the service asks again about an invite into this household.
  @ApiOperation({
    summary: 'Invite someone to the household (owner or admin)',
    description:
      'Name the invitee by `inviteeId` or by `inviteeEmail`, exactly one. An address opens an email-only ' +
      'invite whether or not an account holds it, and nothing in the answer says which. No email is sent yet. ' +
      'The invite expires after seven days. A second outstanding invite to the same id or address is refused, ' +
      'as is an invite by id to a current member, or an invite to yourself. Who may be invited is decided by ' +
      "the server's invitee policy, a block between the two, and the invitee's own preference. By id, any of " +
      "them refuses. By address, only the server's policy does: under `Friends`, every address is refused.",
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Invite created' })
  @ApiResponse({ status: Http.BadRequest, description: 'Not exactly one invitee, an invalid field, or yourself' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      "Not an owner or admin of this household; or the server's invitee policy refuses this invitee, or, " +
      "named by id, a block between the two or the invitee's preference does",
  })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted, or no user with that id' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'The invitee, named by id, is already a member; or the id or address already has an outstanding invite',
  })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Invite))
  @Post()
  createInvite(@Param('householdId') householdId: string, @Body() dto: CreateHouseholdInviteDto) {
    return from(this.inviteService.createInvite(householdId, dto)).pipe(
      map((invite) => ({ message: t('success.household.invite_created'), invite })),
    );
  }

  @ApiOperation({
    summary: "List the household's invites (owner or admin)",
    description:
      'Newest first. By default only the invites still open; `?status=` picks any status, judged as it stands ' +
      'now, so an outstanding invite past its expiry is `Expired`. Every row carries the role offered, the ' +
      'inviter, and `inviteeName`, which is null for an invite by address that was given no name. A row the ' +
      'caller sent also carries the address and the message they wrote; nobody else’s rows do. Paginated: `?page=` (1-based) and `?limit=`, with a `pagination` envelope ' +
      'carrying `total`, `totalPages` and `hasMore`. See #230.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiPaginatedEnvelope('invites')
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner or admin of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Invite))
  @Get()
  listInvites(@Param('householdId') householdId: string, @Query() query: ListHouseholdInvitesQueryDto) {
    return from(this.inviteService.listInvites(householdId, query)).pipe(
      map((page) => paginated('invites', page, query, ResourceType.Invite)),
    );
  }
}
