import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { NoCache, paginated, PaginatedResponseDto } from '@bge/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { GameCollectionDto, ListUserGameCollectionsQueryDto } from './dto';
import { GameCollectionService } from './game-collection.service';

const PaginatedGameCollectionResponse = PaginatedResponseDto(GameCollectionDto, 'collections');

/**
 * Another user's collection, addressed under that user (#514). It used to be
 * `GET /game-collections/user/:userId`, a path whose prefix promised the
 * caller's own collection.
 *
 * Its own class rather than a handler on `UserController`: that would make the
 * user lib import this one, and feature libs don't import each other.
 *
 * Never response-cached. The rows are someone else's and the viewer's access to
 * them can change without the viewer doing anything: an unfriending, or the
 * owner making an entry Private, would otherwise go unseen for the cache TTL.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('game-collections')
@NoCache()
@UseGuards(PoliciesGuard)
@Controller('users/:userId/game-collections')
export class UserGameCollectionsController {
  constructor(private readonly gameCollectionService: GameCollectionService) {}

  @ApiOperation({
    summary: "List another user's visible collection",
    description:
      'Entries filtered by visibility: household-shared, friend-shared, and public for signed-in viewers; ' +
      'public only for an anonymous (guest) session. A session is required.',
  })
  @ApiParam({ name: 'userId', type: String })
  @ApiResponse({ status: Http.Ok, type: PaginatedGameCollectionResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get()
  getUserCollection(@Param('userId') userId: string, @Query() query: ListUserGameCollectionsQueryDto) {
    return from(this.gameCollectionService.listForUser(userId, query)).pipe(
      map((page) => paginated('collections', page, query, ResourceType.GameCollection)),
    );
  }
}
