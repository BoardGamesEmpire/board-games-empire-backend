import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CollectionRatingService } from './collection-rating.service';
import { CollectionRatingListResponseDto } from './dto';

/**
 * The history of a collection entry's rating, on the entry owner's route (#1231).
 * The entry's own routes append to it: each change of the rating, and
 * clearing it, is kept.
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
    description: 'Collection entry not found, or not yours (code COLLECTION_ENTRY_NOT_FOUND)',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get()
  listRatings(@Param('id') id: string) {
    return from(this.ratings.list(id)).pipe(map((ratings) => ({ ratings })));
  }
}
