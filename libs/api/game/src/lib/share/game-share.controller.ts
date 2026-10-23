import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto, paginated, PaginatedResponseDto } from '@bge/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CreateGameShareDto, GameShareDto, GameShareResponseDto } from './dto';
import { GameShareService } from './game-share.service';

const PaginatedGameSharesResponse = PaginatedResponseDto(GameShareDto, 'shares');

/**
 * A game's shares, from the game's side (#810): sharing it, listing its
 * shares, and removing one. Approving a member's share is the household's
 * route.
 *
 * Each route's check below is type-only, so it passes anyone holding any
 * share permission; the service asks again about the share itself.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('game-shares')
@UseGuards(PoliciesGuard)
@Controller('games/:id/shares')
export class GameShareController {
  constructor(private readonly gameShareService: GameShareService) {}

  @ApiOperation({
    summary: 'Share a game with a user or a household',
    description:
      'Shows the game to one registered user, or to every member of one household, on top of its reach: a ' +
      'share adds readers and never takes any away. Only the person who created the game shares it, and only ' +
      'a live game. Name the recipient by `userId` or by `householdId`, exactly one. A share to a user takes ' +
      'effect at once; it is refused for yourself, and while a block stands between the two of you, whichever ' +
      'of you placed it. A block placed later hides the game from them again until it is lifted. To share into ' +
      'a household you must be in it. A household owner or admin shares directly. A member shares as the ' +
      "household's `settings.memberSharePolicy` says: under `Direct` the share takes effect at once; under " +
      '`NeedsApproval` it waits, showing the game to nobody, until a household owner or admin approves it; ' +
      'under `Off` a member cannot share. A household guest never shares into the household. `approvedAt` is ' +
      'null on a share that waits. The same game is shared with a recipient once.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The game to share' })
  @ApiResponse({ status: Http.Created, type: GameShareResponseDto, description: 'Shared: `{ share }`' })
  @ApiResponse({ status: Http.BadRequest, description: 'Not exactly one recipient, an invalid field, or yourself' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'Insufficient permissions; a live game someone else created; a block between you and the user; or, in ' +
      'the household, a role or member share policy that lets you share neither directly nor for approval',
  })
  @ApiResponse({
    status: Http.NotFound,
    description:
      'No live game with that id; no registered user with that id; or no live household with that id that ' +
      'you are in',
  })
  @ApiResponse({ status: Http.Conflict, description: 'The game is already shared with this recipient' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.GameShare))
  @Post()
  createShare(@Param('id') gameId: string, @Body() dto: CreateGameShareDto) {
    return from(this.gameShareService.create(gameId, dto)).pipe(map((share) => ({ share })));
  }

  @ApiOperation({
    summary: "List a game's shares",
    description:
      'Newest first. The person who created the game sees every share of it, to users and households, ' +
      'waiting ones included. A household’s owners and admins see the share of it into their household. ' +
      'Staff and the Owner, who read every share, see them all. Anyone else gets an empty page: whether the ' +
      'game exists is answered at `GET /games/:id`. Paginated: `?page=` (1-based) and `?limit=`, with a ' +
      '`pagination` envelope carrying `total`, `totalPages` and `hasMore`. See #230.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: PaginatedGameSharesResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameShare))
  @Get()
  listShares(@Param('id') gameId: string, @Query() paginationQuery: DefaultPaginationQueryDto) {
    return from(this.gameShareService.listForGame(gameId, paginationQuery)).pipe(
      map((page) => paginated('shares', page, paginationQuery, ResourceType.GameShare)),
    );
  }

  @ApiOperation({
    summary: 'Remove a share',
    description:
      'Stops showing the game to the share’s recipient; its reach still applies. Whoever made the share ' +
      'removes it, at any time, including from a household that has been deleted, so a restored household ' +
      'does not bring it back. A household owner or admin removes any share into their household, waiting ' +
      'or in effect, whoever made it, while the household is not deleted.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'shareId', type: String })
  @ApiResponse({ status: Http.NoContent, description: 'Removed' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Not the share’s sharer, nor an owner or admin of the household it is into',
  })
  @ApiResponse({
    status: Http.NotFound,
    description:
      'No such share of this game; or, for a household owner or admin removing a share someone else made, ' +
      'the household it is into is deleted',
  })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.GameShare))
  @HttpCode(Http.NoContent)
  @Delete(':shareId')
  deleteShare(@Param('id') gameId: string, @Param('shareId') shareId: string) {
    return from(this.gameShareService.delete(gameId, shareId));
  }
}
