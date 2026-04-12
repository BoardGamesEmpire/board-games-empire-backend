import { Action, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Body, Controller, Delete, Get, Inject, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import type { Cache } from 'cache-manager';
import { ClsService } from 'nestjs-cls';
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
    private readonly cls: ClsService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  @ApiOperation({ summary: 'List games' })
  @ApiResponse({ status: 200, type: GameListResponseDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Game))
  @Get()
  getGames(@Query() paginationQuery: PaginationQueryDto) {
    const abilities = this.getAbilities();
    return from(this.gameService.getGames(paginationQuery, abilities)).pipe(map((games) => ({ games })));
  }

  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: GameListResponseDto })
  @ApiResponse({ status: 404, description: 'Game not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Game))
  @Get(':id')
  getGameById(@Param('id') id: string) {
    const abilities = this.getAbilities();
    return from(this.gameService.getGame(id, abilities)).pipe(map((game) => ({ game })));
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Game))
  @Post()
  createGame(@Session() session: UserSession, @Body() createGameDto: CreateGameDto) {
    return from(this.gameService.createGame(session.user.id, createGameDto)).pipe(
      tap((game) => this.logger.log(`Game with ID ${game.id} created by user ${session.user.id}`)),
      map((game) => ({ game, message: 'Game created successfully' })),
      tap(() => this.cache.del(`bge:user:permissions:${session.user.id}`)),
    );
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Game))
  @Patch(':id')
  updateGame(@Param('id') id: string, @Session() session: UserSession, @Body() updateGameDto: UpdateGameDto) {
    const abilities = this.getAbilities();
    return from(this.gameService.updateGame(id, updateGameDto, abilities)).pipe(
      tap((game) => this.logger.log(`Game with ID ${game.id} updated by user ${session.user.id}`)),
      map((game) => ({ game, message: 'Game updated successfully' })),
    );
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.Game))
  @Delete(':id')
  deleteGame(@Param('id') id: string) {
    const abilities = this.getAbilities();
    return from(this.gameService.deleteGame(id, abilities)).pipe(
      tap(() => this.logger.log(`Game with ID ${id} deleted`)),
      map((game) => ({ message: 'Game deleted successfully', game })),
    );
  }

  private getAbilities() {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    const apiAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return [userAbility, apiAbility].filter(Boolean);
  }
}
