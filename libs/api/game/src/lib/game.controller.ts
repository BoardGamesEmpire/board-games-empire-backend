import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Body, Controller, Delete, Get, Inject, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { Cache } from 'cache-manager';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { CreateGameDto, GameListResponseDto, UpdateGameDto } from './dto';
import { GameService } from './game.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('games')
@UseGuards(PoliciesGuard)
@Controller('games')
export class GameController {
  private readonly logger = new Logger(GameController.name);

  constructor(
    private readonly gameService: GameService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  @ApiOperation({ summary: 'List games' })
  @ApiResponse({ status: Http.Ok, type: GameListResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Game))
  @Get()
  getGames(@Query() paginationQuery: PaginationQueryDto) {
    return from(this.gameService.getGames(paginationQuery)).pipe(map((games) => ({ games })));
  }

  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: GameListResponseDto })
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
      tap((game) => this.logger.log(`Game with ID ${game.id} created by user ${game.createdById}`)),
      map((game) => ({ game, message: 'Game created successfully' })),
      tap(({ game }) => this.cache.del(`bge:user:permissions:${game.createdById}`)),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Game))
  @Patch(':id')
  updateGame(@Param('id') id: string, @Body() updateGameDto: UpdateGameDto) {
    return from(this.gameService.updateGame(id, updateGameDto)).pipe(
      tap((game) => this.logger.log(`Game with ID ${game.id} updated by user ${game.updatedById}`)),
      map((game) => ({ game, message: 'Game updated successfully' })),
      tap(({ game }) => this.cache.del(`bge:user:permissions:${game.updatedById}`)),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.Game))
  @Delete(':id')
  deleteGame(@Param('id') id: string) {
    return from(this.gameService.deleteGame(id)).pipe(
      tap(() => this.logger.log(`Game with ID ${id} deleted`)),
      map((game) => ({ message: 'Game deleted successfully', game })),
    );
  }
}
