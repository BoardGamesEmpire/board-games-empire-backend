import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { paginated, PaginatedResponseDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  CreateGameCollectionDto,
  GameCollectionDto,
  GameCollectionMessageResponseDto,
  GameCollectionResponseDto,
  ListGameCollectionsQueryDto,
  RemoveGameCollectionQueryDto,
  UpdateGameCollectionDto,
} from './dto';
import { GameCollectionService } from './game-collection.service';

/** Swagger model for the paginated list envelope `GET /game-collections` returns. */
const PaginatedGameCollectionResponse = PaginatedResponseDto(GameCollectionDto, 'collections');

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('game-collections')
// Must stay out of the response cache: the offline-first client writes then
// re-reads to reconcile local state, so a stale read within the cache TTL is a
// correctness bug — not an optimization trade-off.
@UseGuards(PoliciesGuard)
@Controller('game-collections')
export class GameCollectionController {
  constructor(private readonly gameCollectionService: GameCollectionService) {}

  @ApiOperation({
    summary: "List the acting user's game collection",
    description:
      'Paginated: `?page=` (1-based) and `?limit=`, with a `pagination` envelope carrying ' +
      '`total`, `totalPages` and `hasMore`. See #230.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedGameCollectionResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get()
  getOwnCollection(@Query() query: ListGameCollectionsQueryDto) {
    return from(this.gameCollectionService.listOwn(query)).pipe(
      map((page) => paginated('collections', page, query, ResourceType.GameCollection)),
    );
  }

  @ApiOperation({ summary: 'Get a single collection entry' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: GameCollectionResponseDto })
  @ApiResponse({ status: Http.NotFound, description: 'Collection entry not found (code COLLECTION_ENTRY_NOT_FOUND)' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get(':id')
  getCollectionEntry(@Param('id') id: string) {
    return from(this.gameCollectionService.getById(id)).pipe(map((collection) => ({ collection })));
  }

  @ApiOperation({
    summary: "Add a game to the acting user's collection",
    description:
      'Idempotent on (user, platformGame, medium). A new entry is created with one copy, described by `copy`. ' +
      'Adding a removed entry again restores it with its play history and one new copy, described by `copy`, ' +
      'and the offers its removal paused in events count again. Adding an entry you still own updates its ' +
      'fields, ignores `copy` and adds no copy, so a repeated request is harmless. A new entry needs ' +
      'permission to create it; an entry you already have needs permission to update it.',
  })
  @ApiResponse({ status: Http.Created, type: GameCollectionMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A condition on a digital copy (code COLLECTION_CONDITION_DIGITAL), an acquisition after today ' +
      '(code COLLECTION_DATE_IN_FUTURE), a price in a currency that is not an ISO 4217 code ' +
      '(code COLLECTION_CURRENCY_UNKNOWN), a release of another platform game, or a malformed body',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'Insufficient permissions: no permission to create the new entry, or to update the entry you already ' +
      'have for this platform game and medium',
  })
  @ApiResponse({
    status: Http.NotFound,
    description: 'Platform game or release not found, including a platform game deleted while the add ran',
  })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'The removed entry already holds its most copies, removed ones included (code COLLECTION_COPY_LIMIT_REACHED)',
  })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.GameCollection))
  @Post()
  addToCollection(@Body() createGameCollectionDto: CreateGameCollectionDto) {
    return from(this.gameCollectionService.addToCollection(createGameCollectionDto)).pipe(
      map((collection) => ({ collection, message: t('success.game_collection.added') })),
    );
  }

  @ApiOperation({ summary: 'Update a collection entry (omitted fields preserved, null clears)' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: GameCollectionMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Collection entry not found (code COLLECTION_ENTRY_NOT_FOUND)' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Patch(':id')
  updateCollectionEntry(@Param('id') id: string, @Body() updateGameCollectionDto: UpdateGameCollectionDto) {
    return from(this.gameCollectionService.update(id, updateGameCollectionDto)).pipe(
      map((collection) => ({ collection, message: t('success.game_collection.updated') })),
    );
  }

  @ApiOperation({
    summary: "Remove a game from the acting user's collection",
    description:
      'The entry is marked removed, optionally with a reason, so play history survives, and adding the same ' +
      'game back restores it. Each copy you still own is removed with it, dated `removedOn`, or today (UTC) ' +
      'when none is given, with the same reason. ' +
      'In every event that offers it, unless the event was deleted, the offer stops counting: ' +
      'nominations of the game that await an outcome pause, and the game leaves the lineup of every date still ahead. ' +
      'The offers stay, and count again when the game is added back, which resumes the paused nominations.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: GameCollectionMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A removal date after today (code COLLECTION_DATE_IN_FUTURE), or before a copy you own was acquired ' +
      '(code COLLECTION_DATE_ORDER)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Collection entry not found (code COLLECTION_ENTRY_NOT_FOUND)' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.GameCollection))
  @Delete(':id')
  removeFromCollection(@Param('id') id: string, @Query() query: RemoveGameCollectionQueryDto) {
    return from(this.gameCollectionService.remove(id, query)).pipe(
      map((collection) => ({ collection, message: t('success.game_collection.removed') })),
    );
  }
}
