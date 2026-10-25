import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, paginated, PaginationQueryDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CreateHouseholdBanDto, UpdateHouseholdBanDto } from '../dto';
import { HouseholdLivenessGuard, HouseholdPathParam } from '../guards/household-liveness.guard';
import { HouseholdBanService } from './household-ban.service';

// Must stay out of the response cache, for the reasons on
// `HouseholdController`: the list must reflect the ban its caller just made,
// and a cache hit skips the service, where the household is authorized (#528).
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('household-bans')
// Liveness first, as on `HouseholdController` (#299): a missing or deleted
// household is 404 whatever the actor holds elsewhere.
@HouseholdPathParam('householdId')
@UseGuards(HouseholdLivenessGuard, PoliciesGuard)
@Controller('households/:householdId/bans')
export class HouseholdBanController {
  constructor(private readonly banService: HouseholdBanService) {}

  // Each type-only check below passes an owner or admin of any household; the
  // service asks again about a ban from this one.
  @ApiOperation({
    summary: 'Ban someone from the household (owner or admin)',
    description:
      'A banned user can’t be invited to the household by id, never receives an invite there by address, ' +
      'and no admission lets them in. A member is removed from the household, as removing them would; a ' +
      'household admin bans people with the member or guest role, and people who aren’t members, but not ' +
      'a household admin or an owner. Their open invites by id, and the ones they sent, are revoked. Open ' +
      'invites to their address are withheld: they still read as sent. Nobody is notified of the ban, the ' +
      'banned user included. The reason is seen only by the household’s owners and admins.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Banned: `{ message, ban }`.' })
  @ApiResponse({ status: Http.BadRequest, description: 'An invalid field, yourself, or the last owner' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Not an owner or admin of this household, or a household admin banning an admin or an owner',
  })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted, or no user with that id' })
  @ApiResponse({ status: Http.Conflict, description: 'The user is already banned from the household' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.HouseholdBan))
  @Post()
  ban(@Param('householdId') householdId: string, @Body() dto: CreateHouseholdBanDto) {
    return from(this.banService.ban(householdId, dto)).pipe(
      map((ban) => ({ message: t('success.household.ban_created'), ban })),
    );
  }

  @ApiOperation({
    summary: "List the household's bans (owner or admin)",
    description:
      'Newest first. Each ban names the banned user and who banned them, by id and name, and carries the ' +
      'reason. `bannedBy` is null once that user is deleted. Paginated: `?page=` (1-based) and `?limit=`, ' +
      'with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`. See #230.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiPaginatedEnvelope('bans')
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner or admin of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.HouseholdBan))
  @Get()
  list(@Param('householdId') householdId: string, @Query() query: PaginationQueryDto) {
    return from(this.banService.list(householdId, query)).pipe(
      map((page) => paginated('bans', page, query, ResourceType.HouseholdBan)),
    );
  }

  @ApiOperation({
    summary: "Change a ban's reason (owner or admin)",
    description: 'Sets, replaces or clears the reason. Send `{ "reason": null }` to clear it.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'userId', type: String, description: 'The banned user' })
  @ApiResponse({ status: Http.Ok, description: 'Updated: `{ message, ban }`.' })
  @ApiResponse({ status: Http.BadRequest, description: 'No reason given, or an invalid one' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner or admin of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted, or the user isn’t banned' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.HouseholdBan))
  @Patch(':userId')
  updateReason(
    @Param('householdId') householdId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateHouseholdBanDto,
  ) {
    return from(this.banService.updateReason(householdId, userId, dto)).pipe(
      map((ban) => ({ message: t('success.household.ban_updated'), ban })),
    );
  }

  @ApiOperation({
    summary: 'Lift a ban (owner or admin)',
    description:
      'The user may be invited by id again, and an admission lets them in. Invites to their address that ' +
      'the ban withheld reach them, and they are told of each, all but those their blocks or invite ' +
      'preferences would still withhold from the sender. The answer carries the ban as it was.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'userId', type: String, description: 'The banned user' })
  @ApiResponse({ status: Http.Ok, description: 'Lifted: `{ message, ban }`.' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner or admin of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted, or the user isn’t banned' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.HouseholdBan))
  @Delete(':userId')
  lift(@Param('householdId') householdId: string, @Param('userId') userId: string) {
    return from(this.banService.lift(householdId, userId)).pipe(
      map((ban) => ({ message: t('success.household.ban_lifted'), ban })),
    );
  }
}
