import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, paginated } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
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
    summary: 'Invite someone to the household',
    description:
      'An owner or admin invites directly. A member invites as the household’s `settings.memberInvitePolicy` ' +
      'says: under `Direct` the invite goes straight to the invitee; under `NeedsApproval` it opens as ' +
      '`AwaitingApproval`, unseen by the invitee until an owner or admin approves it; under `Off` a member ' +
      'cannot invite. A member may offer the member or guest role, not admin. A guest never invites. ' +
      'Name the invitee by `inviteeId` or by `inviteeEmail`, exactly one. An address opens an email-only ' +
      'invite whether or not an account holds it, and nothing in the answer says which. No email is sent yet. ' +
      'The invite expires after seven days. A second outstanding invite to the same id or address is refused, ' +
      'as is an invite by id to a current member, or an invite to yourself. Who may be invited is decided by ' +
      "the server's invitee policy, a block between the two, and the invitee's own preference. By id, any of " +
      "them refuses. By address, only the server's policy does: under `Friends`, every address is refused.",
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Invite created, `Pending` or `AwaitingApproval`' })
  @ApiResponse({ status: Http.BadRequest, description: 'Not exactly one invitee, an invalid field, or yourself' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'Not a member of this household who may invite, or a member offering the admin role; or the ' +
      "server's invitee policy refuses this invitee, or, named by id, a block between the two or the " +
      "invitee's preference does",
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
      'caller sent also carries the address and the message they wrote. On every other row, the household’s ' +
      'owners and admins see the address too, and nobody sees the message. Paginated: `?page=` (1-based) and ' +
      '`?limit=`, with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`. See #230.',
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

  // The type-only check below passes the Owner or Admin of any household; the
  // service asks again about an invite into this one.
  @ApiOperation({
    summary: 'Revoke an invite someone else sent (owner or admin)',
    description:
      'Cancels an invite into the household, pending or awaiting approval, that someone else sent, whether or ' +
      'not they are still a member. An invite you sent yourself is refused here: withdraw it with ' +
      '`POST /invites/:inviteId/withdraw`, signed in. Through an API key, an invite the key’s owner sent is ' +
      'refused the same way, and withdraw does not take a key. The answer carries the invite as the household ' +
      'sees it: with the address for the household’s owners and admins, and never with the message.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'inviteId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Revoked: `{ message, invite }`, the invite now `Revoked`.' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Not an owner or admin of this household, or you sent this invite: withdraw it instead',
  })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted, or no such invite in it' })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The invite was already settled, or changed while it was being revoked',
  })
  @ApiResponse({ status: Http.Gone, description: 'The invite has expired' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Invite))
  @HttpCode(Http.Ok)
  @Post(':inviteId/revoke')
  revokeInvite(@Param('householdId') householdId: string, @Param('inviteId') inviteId: string) {
    return from(this.inviteService.revokeInvite(householdId, inviteId)).pipe(
      map((invite) => ({ message: t('success.household.invite_revoked'), invite })),
    );
  }

  // The type-only check below passes the Owner or Admin of any household; the
  // service asks again about an invite into this one, and about the column an
  // approval writes, so the revoke permission does not pass for it.
  @ApiOperation({
    summary: "Approve a member's invite (owner or admin)",
    description:
      'Opens an invite awaiting approval to its invitee, who sees it from then on and may accept it. Find the ' +
      'invites waiting with `GET /households/:householdId/invites?status=AwaitingApproval`; turn one down by ' +
      'revoking it. An invite you sent yourself, before you could invite directly, may be approved too. The ' +
      'answer carries the invite as the household sees it: with the address for the household’s owners and ' +
      'admins, and never with the message.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'inviteId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Approved: `{ message, invite }`, the invite now `Pending`.' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner or admin of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted, or no such invite in it' })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The invite is not awaiting approval, or changed while it was being approved',
  })
  @ApiResponse({ status: Http.Gone, description: 'The invite has expired' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Invite))
  @HttpCode(Http.Ok)
  @Post(':inviteId/approve')
  approveInvite(@Param('householdId') householdId: string, @Param('inviteId') inviteId: string) {
    return from(this.inviteService.approveInvite(householdId, inviteId)).pipe(
      map((invite) => ({ message: t('success.household.invite_approved'), invite })),
    );
  }
}
