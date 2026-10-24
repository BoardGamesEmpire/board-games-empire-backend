import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, DefaultPaginationQueryDto, paginated } from '@bge/shared';
import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { HouseholdLivenessGuard, HouseholdPathParam } from '../guards/household-liveness.guard';
import { HouseholdGameShareService } from './household-game-share.service';

/**
 * A household's game shares, from the household's side (#810): listing them,
 * and approving a member's waiting share. Sharing a game into the household,
 * and removing a share from it, are the game's routes under
 * `/games/:id/shares`.
 *
 * Must stay out of the response cache, for the reasons on
 * `HouseholdController`: the list must show the share its caller just made or
 * approved, and a cache hit skips the service, where the household is
 * authorized (#528).
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('household-game-shares')
// Liveness first, as on `HouseholdController` (#299): a missing or deleted
// household is 404 whatever the actor holds elsewhere.
@HouseholdPathParam('householdId')
@UseGuards(HouseholdLivenessGuard, PoliciesGuard)
@Controller('households/:householdId/game-shares')
export class HouseholdGameShareController {
  constructor(private readonly gameShareService: HouseholdGameShareService) {}

  // The type-only check below passes every user, who reads the shares of the
  // games they created; the service asks again about this household's shares.
  @ApiOperation({
    summary: "List the household's game shares (owner or admin)",
    description:
      'Newest first. Every share of a game into the household, whoever made it: those in effect, and a ' +
      "member's shares still waiting for approval, which have a null `approvedAt`. Each row carries its " +
      'game’s `id`, `title` and `thumbnail`, so an approver can tell what they are approving. Paginated: ' +
      '`?page=` (1-based) and `?limit=`, with a `pagination` envelope carrying `total`, `totalPages` and ' +
      '`hasMore`. See #230.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiPaginatedEnvelope('shares')
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner or admin of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameShare))
  @Get()
  listShares(@Param('householdId') householdId: string, @Query() query: DefaultPaginationQueryDto) {
    return from(this.gameShareService.listShares(householdId, query)).pipe(
      map((page) => paginated('shares', page, query, ResourceType.GameShare)),
    );
  }

  // The type-only check below passes the owner or admin of any household; the
  // service asks again about a share of this one, and about the column an
  // approval writes.
  @ApiOperation({
    summary: "Approve a member's game share (owner or admin)",
    description:
      "Puts a member's share waiting for approval in effect, and the game shows to the household's members " +
      'from then on. Find the shares waiting with `GET /households/:householdId/game-shares`: their ' +
      '`approvedAt` is null. Turn one down by removing it with `DELETE /games/:id/shares/:shareId`. A share ' +
      'is approvable only while the person who made it could still share it, directly or for approval, under ' +
      "their household role and the household's `settings.memberSharePolicy` as they are now: not once they " +
      'are a guest or the policy is `Off`.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'shareId', type: String })
  @ApiResponse({
    status: Http.Ok,
    description: 'Approved: `{ share }`, with `approvedAt` and `approvedById` now set',
  })
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner or admin of this household' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'Household not found or deleted, or no such share in it',
  })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The share is already in effect, or the person who made it could no longer share it',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameShare))
  @HttpCode(Http.Ok)
  @Post(':shareId/approve')
  approveShare(@Param('householdId') householdId: string, @Param('shareId') shareId: string) {
    return from(this.gameShareService.approve(householdId, shareId)).pipe(map((share) => ({ share })));
  }
}
