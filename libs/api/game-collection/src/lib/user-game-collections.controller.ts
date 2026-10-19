import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { paginated, PaginatedResponseDto } from '@bge/shared';
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
 * Must stay out of the response cache. The rows are someone else's and the
 * viewer's access to them can change without the viewer doing anything: an
 * unfriending, or the owner making an entry Private, would otherwise go unseen
 * for the cache TTL.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('game-collections')
@UseGuards(PoliciesGuard)
@Controller('users/:userId/game-collections')
export class UserGameCollectionsController {
  constructor(private readonly gameCollectionService: GameCollectionService) {}

  @ApiOperation({
    summary: "List another user's visible collection",
    description:
      'The entries the caller may see. A signed-in viewer sees what the owner shares with a household they ' +
      'share (whatever its reach, unless the owner excluded it), what reaches the owner\u2019s friends when ' +
      'they are one, and what is `Public`. An anonymous (guest) session sees `Public` entries only. A ' +
      'session is required.',
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
