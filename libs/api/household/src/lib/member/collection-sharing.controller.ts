import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { ExcludeGameDto, UpdateCollectionSharingDto } from '../dto';
import { HouseholdLivenessGuard, HouseholdPathParam } from '../guards/household-liveness.guard';
import { CollectionSharingService } from './collection-sharing.service';

/**
 * The caller's own collection sharing with a household and their excluded
 * games (#170). Every route acts on the caller's own membership, never
 * another member's, whatever the caller's household role.
 *
 * Mounted beside `HouseholdMemberController`'s `members/:memberId` routes
 * without colliding: none of those has a `PATCH` on one segment, and the
 * excluded-game paths are longer than any of them.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('household-members')
// Liveness first, as on `HouseholdMemberController` (#299).
@HouseholdPathParam('householdId')
@UseGuards(HouseholdLivenessGuard, PoliciesGuard)
@Controller('households/:householdId/members/me')
export class CollectionSharingController {
  constructor(private readonly collectionSharing: CollectionSharingService) {}

  @ApiOperation({
    summary: 'Turn your collection sharing with the household on or off',
    description:
      'Whether your games join the household’s game pool (#170). Your excluded games stay out either way. ' +
      'Returns your roster row.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Collection sharing updated' })
  @ApiResponse({ status: Http.BadRequest, description: '`collectionSharing` is not a JSON boolean' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Insufficient permissions, or you hold no household membership this action could apply to',
  })
  @ApiResponse({ status: Http.NotFound, description: 'Not a member, or household not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.HouseholdMember))
  @Patch()
  setCollectionSharing(@Param('householdId') householdId: string, @Body() dto: UpdateCollectionSharingDto) {
    return from(this.collectionSharing.setCollectionSharing(householdId, dto)).pipe(
      map((member) => ({ message: t('success.household.collection_sharing_updated'), member })),
    );
  }

  @ApiOperation({
    summary: 'List your excluded games for the household',
    description:
      'The games you hold back from the household’s game pool (#170), newest first, with your reasons. ' +
      'Not paged: the list is bounded by your own collection.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Excluded games retrieved' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Not a member, or household not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.HouseholdMember))
  @Get('excluded-games')
  listExcludedGames(@Param('householdId') householdId: string) {
    return from(this.collectionSharing.listExcludedGames(householdId)).pipe(
      map((excludedGames) => ({ excludedGames })),
    );
  }

  @ApiOperation({
    summary: 'Exclude one of your games from the household’s game pool',
    description:
      'Holds one of your own collection entries back from the household’s game pool (#170). ' +
      'A repeat for the same entry replaces the reason, and one that omits it or sends it blank clears it. ' +
      'The reason is never sent in a webhook.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Game excluded' })
  @ApiResponse({ status: Http.BadRequest, description: 'Invalid body' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Insufficient permissions, or you hold no household membership this action could apply to',
  })
  @ApiResponse({
    status: Http.NotFound,
    description:
      'Not a member, household not found, or no such entry in your collection (code COLLECTION_ENTRY_NOT_FOUND)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.HouseholdMember))
  @Post('excluded-games')
  excludeGame(@Param('householdId') householdId: string, @Body() dto: ExcludeGameDto) {
    return from(this.collectionSharing.excludeGame(householdId, dto)).pipe(
      map((excludedGame) => ({ message: t('success.household.excluded_game_added'), excludedGame })),
    );
  }

  @ApiOperation({
    summary: 'Put an excluded game back into the household’s game pool',
    description: 'Stops excluding one of your collection entries (#170).',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiParam({ name: 'collectionEntryId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Game no longer excluded' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Insufficient permissions, or you hold no household membership this action could apply to',
  })
  @ApiResponse({
    status: Http.NotFound,
    description: 'Not a member, household not found, or the game is not excluded (code EXCLUDED_GAME_NOT_FOUND)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.HouseholdMember))
  @Delete('excluded-games/:collectionEntryId')
  removeExcludedGame(@Param('householdId') householdId: string, @Param('collectionEntryId') collectionEntryId: string) {
    return from(this.collectionSharing.removeExcludedGame(householdId, collectionEntryId)).pipe(
      map(() => ({ message: t('success.household.excluded_game_removed') })),
    );
  }
}
