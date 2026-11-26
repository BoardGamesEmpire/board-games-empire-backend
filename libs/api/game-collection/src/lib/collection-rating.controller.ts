import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CollectionRatingService } from './collection-rating.service';
import {
  CollectionRatingChangeMessageResponseDto,
  CollectionRatingListResponseDto,
  CollectionRatingRevisionListResponseDto,
  CreateCollectionRatingChangeDto,
  UpdateCollectionRatingChangeDto,
} from './dto';

const ENTRY_NOT_FOUND = 'Collection entry not found, or not yours (code COLLECTION_ENTRY_NOT_FOUND)';
const RATING_NOT_FOUND = 'the rating change was not found on it (code COLLECTION_RATING_NOT_FOUND)';

/**
 * The history of a collection entry's rating, on the entry owner's routes (#1231).
 * The entry's own routes append to it: each change of the rating, and
 * clearing it, is kept. The owner corrects the history here, and a correction
 * never changes the entry's current rating. Every route, the writes as much
 * as the reads, answers only the entry's owner, and each write is an update
 * of the entry, held to its conditions.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('game-collections')
// Must stay out of the response cache, as the entry routes do: the
// offline-first client writes then re-reads to reconcile local state.
@UseGuards(PoliciesGuard)
@Controller('game-collections/:id/ratings')
export class CollectionRatingController {
  constructor(private readonly ratings: CollectionRatingService) {}

  @ApiOperation({
    summary: 'List the changes of the rating of one of your collection entries',
    description:
      'Every change of the rating, oldest first, the ones with no known date before the rest. Each time the ' +
      'rating changes, or you clear it, a change is kept, dated today. Only the entry’s owner sees the history, ' +
      'whatever the entry’s reach.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiResponse({ status: Http.Ok, type: CollectionRatingListResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: ENTRY_NOT_FOUND,
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get()
  listRatings(@Param('id') id: string) {
    return from(this.ratings.list(id)).pipe(map((ratings) => ({ ratings })));
  }

  @ApiOperation({
    summary: 'Add an earlier rating to one of your collection entries',
    description:
      'Adds a change of the rating with the date it happened on, for a rating you gave before you used the app. ' +
      'It never changes the entry’s current rating. Send `rating: null` for a change that cleared the rating. ' +
      'Only the entry’s owner can add one: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiResponse({ status: Http.Created, type: CollectionRatingChangeMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A date on a day that hasn’t begun anywhere on Earth yet (code COLLECTION_DATE_IN_FUTURE, with `field`), ' +
      'or a malformed body',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: ENTRY_NOT_FOUND })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Post()
  addRating(@Param('id') id: string, @Body() dto: CreateCollectionRatingChangeDto) {
    return from(this.ratings.add(id, dto)).pipe(
      map((ratingChange) => ({ ratingChange, message: t('success.game_collection.rating_change_added') })),
    );
  }

  @ApiOperation({
    summary: 'Correct a rating change (omitted fields preserved)',
    description:
      'Changes the rating or the date of a change in the history, and keeps what it said before as a revision. ' +
      '`rating: null` makes it a change that cleared the rating, and `occurredOn: null` makes its date unknown. ' +
      'The entry’s current rating stays as it is. A change taken back can’t be corrected until the take-back is ' +
      'undone. Only the entry’s owner can correct one: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'ratingId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionRatingChangeMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'No field to change, a date on a day that hasn’t begun anywhere on Earth yet ' +
      '(code COLLECTION_DATE_IN_FUTURE, with `field`), or a malformed body',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: `${ENTRY_NOT_FOUND}, or ${RATING_NOT_FOUND}, or taken back`,
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Patch(':ratingId')
  updateRating(
    @Param('id') id: string,
    @Param('ratingId') ratingId: string,
    @Body() dto: UpdateCollectionRatingChangeDto,
  ) {
    return from(this.ratings.update(id, ratingId, dto)).pipe(
      map((ratingChange) => ({ ratingChange, message: t('success.game_collection.rating_change_updated') })),
    );
  }

  @ApiOperation({
    summary: 'Take back a rating change that never happened',
    description:
      'Says the change never happened. It stays in the history, flagged with `retractedAt`, and the entry’s ' +
      'current rating stays as it is. A change taken back can’t be corrected or restored until the take-back is ' +
      'undone. Only the entry’s owner can take one back: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'ratingId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionRatingChangeMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: `${ENTRY_NOT_FOUND}, or ${RATING_NOT_FOUND}, or taken back already`,
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @HttpCode(Http.Ok)
  @Post(':ratingId/retraction')
  takeBackRating(@Param('id') id: string, @Param('ratingId') ratingId: string) {
    return from(this.ratings.takeBack(id, ratingId)).pipe(
      map((ratingChange) => ({ ratingChange, message: t('success.game_collection.rating_change_taken_back') })),
    );
  }

  @ApiOperation({
    summary: 'Undo taking back a rating change',
    description:
      'The change counts again. Only the entry’s owner can undo one: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'ratingId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionRatingChangeMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: `${ENTRY_NOT_FOUND}, or ${RATING_NOT_FOUND}` })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The change exists but is not taken back (code COLLECTION_RATING_NOT_TAKEN_BACK)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Delete(':ratingId/retraction')
  undoTakeBackRating(@Param('id') id: string, @Param('ratingId') ratingId: string) {
    return from(this.ratings.undoTakeBack(id, ratingId)).pipe(
      map((ratingChange) => ({ ratingChange, message: t('success.game_collection.rating_change_take_back_undone') })),
    );
  }

  @ApiOperation({
    summary: 'List the revisions of a rating change',
    description:
      'Each correction or restore of a rating change first keeps what it said before as a revision. Newest first, ' +
      'each in the shape you read the change. A change taken back keeps its revisions readable. Only the ' +
      'entry’s owner sees them: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'ratingId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionRatingRevisionListResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: `${ENTRY_NOT_FOUND}, or ${RATING_NOT_FOUND}` })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get(':ratingId/revisions')
  listRevisions(@Param('id') id: string, @Param('ratingId') ratingId: string) {
    return from(this.ratings.listRevisions(id, ratingId)).pipe(map((revisions) => ({ revisions })));
  }

  @ApiOperation({
    summary: 'Restore a revision of a rating change',
    description:
      'Writes a revision’s rating and date back to the change, and keeps what the change says now as a revision ' +
      'of its own, so a restore can be undone the same way. The entry’s current rating stays as it is. Only the ' +
      'entry’s owner can restore one: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'ratingId', type: String })
  @ApiParam({ name: 'revisionId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionRatingChangeMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description: 'A date on a day that hasn’t begun anywhere on Earth yet (code COLLECTION_DATE_IN_FUTURE)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description:
      `${ENTRY_NOT_FOUND}, ${RATING_NOT_FOUND} or taken back, or the revision not found on the change, including ` +
      'one whose stored values can’t be read back (code COLLECTION_REVISION_NOT_FOUND)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @HttpCode(Http.Ok)
  @Post(':ratingId/revisions/:revisionId/restore')
  restoreRevision(
    @Param('id') id: string,
    @Param('ratingId') ratingId: string,
    @Param('revisionId') revisionId: string,
  ) {
    return from(this.ratings.restore(id, ratingId, revisionId)).pipe(
      map((ratingChange) => ({ ratingChange, message: t('success.game_collection.rating_change_restored') })),
    );
  }
}
