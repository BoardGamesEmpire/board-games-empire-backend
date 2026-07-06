import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { NoCache } from '@bge/shared';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  CreateGameCollectionDto,
  GameCollectionListResponseDto,
  GameCollectionMessageResponseDto,
  GameCollectionResponseDto,
  ListGameCollectionsQueryDto,
  ListUserGameCollectionsQueryDto,
  RemoveGameCollectionQueryDto,
  UpdateGameCollectionDto,
} from './dto';
import { GameCollectionService } from './game-collection.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('game-collections')
// Never response-cached: the offline-first client writes then re-reads to
// reconcile local state, so a stale read within the cache TTL is a
// correctness bug — not an optimization trade-off.
@NoCache()
@UseGuards(PoliciesGuard)
@Controller('game-collections')
export class GameCollectionController {
  constructor(private readonly gameCollectionService: GameCollectionService) {}

  @ApiOperation({ summary: "List the acting user's game collection" })
  @ApiResponse({ status: Http.Ok, type: GameCollectionListResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get()
  getOwnCollection(@Query() query: ListGameCollectionsQueryDto) {
    return from(this.gameCollectionService.listOwn(query)).pipe(map((collections) => ({ collections })));
  }

  @ApiOperation({
    summary: "List another user's visible collection",
    description:
      'Entries filtered by visibility: household-shared, friend-shared, and public for authenticated ' +
      'viewers; public only for anonymous viewers.',
  })
  @ApiParam({ name: 'userId', type: String })
  @ApiResponse({ status: Http.Ok, type: GameCollectionListResponseDto })
  @AllowAnonymous()
  @Get('user/:userId')
  getUserCollection(@Param('userId') userId: string, @Query() query: ListUserGameCollectionsQueryDto) {
    return from(this.gameCollectionService.listForUser(userId, query)).pipe(map((collections) => ({ collections })));
  }

  @ApiOperation({ summary: 'Get a single collection entry' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: GameCollectionResponseDto })
  @ApiResponse({ status: Http.NotFound, description: 'Collection entry not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get(':id')
  getCollectionEntry(@Param('id') id: string) {
    return from(this.gameCollectionService.getById(id)).pipe(map((collection) => ({ collection })));
  }

  @ApiOperation({
    summary: "Add a game to the acting user's collection",
    description:
      'Idempotent upsert on (user, platformGame, medium): re-adding an active entry updates it, ' +
      're-adding a removed entry resurrects it with play history intact.',
  })
  @ApiResponse({ status: Http.Created, type: GameCollectionMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Platform game or release not found' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.GameCollection))
  @Post()
  addToCollection(@Body() createGameCollectionDto: CreateGameCollectionDto) {
    return from(this.gameCollectionService.addToCollection(createGameCollectionDto)).pipe(
      map((collection) => ({ collection, message: 'Game added to collection successfully' })),
    );
  }

  @ApiOperation({ summary: 'Update a collection entry (omitted fields preserved, null clears)' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: GameCollectionMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Collection entry not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Patch(':id')
  updateCollectionEntry(@Param('id') id: string, @Body() updateGameCollectionDto: UpdateGameCollectionDto) {
    return from(this.gameCollectionService.update(id, updateGameCollectionDto)).pipe(
      map((collection) => ({ collection, message: 'Collection entry updated successfully' })),
    );
  }

  @ApiOperation({
    summary: "Remove a game from the acting user's collection",
    description:
      'Soft delete: the entry is tombstoned (optionally with a reason) so play history survives; ' +
      're-adding the same game resurrects it.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: GameCollectionMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Collection entry not found' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.GameCollection))
  @Delete(':id')
  removeFromCollection(@Param('id') id: string, @Query() query: RemoveGameCollectionQueryDto) {
    return from(this.gameCollectionService.remove(id, query)).pipe(
      map((collection) => ({ collection, message: 'Game removed from collection successfully' })),
    );
  }
}
