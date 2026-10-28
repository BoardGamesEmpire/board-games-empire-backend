import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { paginated, PaginatedResponseDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { CreateGameDto, GameDto, GameResponseDto, ListGamesQueryDto, UpdateGameDto } from './dto';
import { GameService } from './game.service';

const PaginatedGamesResponse = PaginatedResponseDto(GameDto, 'games');

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('games')
@UseGuards(PoliciesGuard)
@Controller('games')
export class GameController {
  private readonly logger = new Logger(GameController.name);

  constructor(private readonly gameService: GameService) {}

  @ApiOperation({
    summary: 'List games',
    description:
      'The live Public games, the acting user’s own whatever their reach, their friends’ that reach ' +
      'friends, their friends of friends’ that reach friends of friends, and the games shared with them or ' +
      'with a household they belong to once the share is in effect — one rule for every role, ' +
      'and the set the local half of `GET /games/search` searches. Soft-deleted games are excluded. ' +
      '**Breaking change (#513).** Owner/Admin/Moderator previously also received every private game on the ' +
      'server, with `pagination.total` counting them. A private game they can read is still readable at ' +
      '`GET /games/:id`. An **API key** is additionally floored by its own permissions (effective access is ' +
      'key ∩ owner). Alphabetical by title, or with `?sort=newest` the games most recently added to the game ' +
      'catalog first. Either order ends in the game id, so a repeated request answers the same page while the ' +
      'list is unchanged. Pages are offsets: a game added or removed between two requests shifts the pages after ' +
      'it, and under `?sort=newest` an added game lands on page 1. Paginated: `?page=` (1-based) and `?limit=`, ' +
      'with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`; `total` counts the same set. ' +
      'See #230.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedGamesResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'Insufficient permissions, or an actor kind with no games of its own (plugin, system, external) ' +
      '— new with #513, and provisional: see #395',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Game))
  @Get()
  getGames(@Query() query: ListGamesQueryDto) {
    return from(this.gameService.getGames(query)).pipe(
      map((page) => paginated('games', page, query, ResourceType.Game)),
    );
  }

  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: GameResponseDto })
  @ApiResponse({ status: Http.NotFound, description: 'Game not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Game))
  @Get(':id')
  getGameById(@Param('id') id: string) {
    return from(this.gameService.getGame(id)).pipe(map((game) => ({ game })));
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Game))
  @Post()
  createGame(@Body() createGameDto: CreateGameDto) {
    return from(this.gameService.createGame(createGameDto)).pipe(
      // The service creates the game and evicts the creator's permission graph.
      tap((game) => this.logger.log(`Game with ID ${game.id} created by user ${game.createdById}`)),
      map((game) => ({ game, message: t('success.game.created') })),
    );
  }

  @ApiResponse({ status: Http.BadRequest, description: 'Empty patch, or an imported game made anything but public' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Game))
  @Patch(':id')
  updateGame(@Param('id') id: string, @Body() updateGameDto: UpdateGameDto) {
    return from(this.gameService.updateGame(id, updateGameDto)).pipe(
      // The service updates the game and evicts the updater's permission graph.
      tap((game) => this.logger.log(`Game with ID ${game.id} updated by user ${game.updatedById}`)),
      map((game) => ({ game, message: t('success.game.updated') })),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.Game))
  @Delete(':id')
  deleteGame(@Param('id') id: string) {
    return from(this.gameService.deleteGame(id)).pipe(
      tap(() => this.logger.log(`Game with ID ${id} deleted`)),
      map((game) => ({ message: t('success.game.deleted'), game })),
    );
  }
}
