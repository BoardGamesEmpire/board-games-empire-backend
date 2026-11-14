import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto, paginated, PaginatedResponseDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  CreateListEntryDto,
  ListEntriesResponseDto,
  ListEntryDeletedResponseDto,
  ListEntryDto,
  ListEntryMessageResponseDto,
  ReorderListEntriesDto,
  UpdateListEntryDto,
} from './dto';
import { ListEntryService } from './list-entry.service';

/** Swagger model for the paginated envelope `GET /lists/:listId/entries` returns. */
const PaginatedListEntryResponse = PaginatedResponseDto(ListEntryDto, 'entries');

/**
 * A list's entries, addressed under the list (#1241). An entry is read with
 * its list and written as part of it, so these routes ask the list's own
 * permissions: `read` on List to read, `update` on List for every write. The
 * service then applies the list's ceilings to the list the path names.
 *
 * Must stay out of the response cache, as the list routes do: a client
 * reorders or edits entries and re-reads them to reconcile, so a stale read
 * within the cache TTL is a correctness bug.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('lists')
@UseGuards(PoliciesGuard)
@Controller('lists/:listId/entries')
export class ListEntryController {
  constructor(private readonly listEntryService: ListEntryService) {}

  @ApiOperation({
    summary: "List a list's entries",
    description:
      'In the order the list’s owner chose. Readable by whoever may read the list. Paginated: `?page=` (1-based) ' +
      'and `?limit=`, with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`.',
  })
  @ApiParam({ name: 'listId', type: String })
  @ApiResponse({ status: Http.Ok, type: PaginatedListEntryResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'List not found (code LIST_NOT_FOUND)' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.List))
  @Get()
  getEntries(@Param('listId') listId: string, @Query() query: DefaultPaginationQueryDto) {
    return from(this.listEntryService.list(listId, query)).pipe(
      map((page) => paginated('entries', page, query, ResourceType.List)),
    );
  }

  @ApiOperation({
    summary: "Replace the order of a list's entries",
    description:
      'Send every one of the list’s entry ids, first to last. Positions are renumbered from 0 in that order. A ' +
      'request that is not exactly the list’s entries now is refused with code `LIST_ORDER_STALE` and changes ' +
      'nothing. Declared before the `:entryId` routes, so `order` is never taken for an id.',
  })
  @ApiParam({ name: 'listId', type: String })
  @ApiResponse({ status: Http.Ok, type: ListEntriesResponseDto })
  @ApiResponse({ status: Http.BadRequest, description: 'Duplicate ids, or more ids than a list can hold' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'List not found (code LIST_NOT_FOUND)' })
  @ApiResponse({ status: Http.Conflict, description: 'Not exactly the list’s entries (code LIST_ORDER_STALE)' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.List))
  @Put('order')
  reorderEntries(@Param('listId') listId: string, @Body() dto: ReorderListEntriesDto) {
    return from(this.listEntryService.reorder(listId, dto)).pipe(map((entries) => ({ entries })));
  }

  @ApiOperation({
    summary: 'Add a game or a platform game to a list',
    description:
      'Name exactly one of `gameId` (the game on any platform) and `platformGameId`. The entry goes after the ' +
      'list’s last one. A priority is for a wishlist’s entries only.',
  })
  @ApiParam({ name: 'listId', type: String })
  @ApiResponse({ status: Http.Created, type: ListEntryMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'Not exactly one of a game and a platform game (code LIST_ENTRY_ONE_TARGET), a priority off a wishlist ' +
      '(code LIST_PRIORITY_WISHLIST_ONLY), or a release without its platform game (codes ' +
      'LIST_ENTRY_RELEASE_NEEDS_PLATFORM_GAME, LIST_ENTRY_RELEASE_MISMATCH)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description:
      'List not found (code LIST_NOT_FOUND), or a game, platform game or release you can’t read (code ' +
      'GAME_NOT_FOUND, PLATFORM_GAME_NOT_FOUND or GAME_RELEASE_NOT_FOUND)',
  })
  @ApiResponse({
    status: Http.Conflict,
    description: 'Already on the list (code LIST_ENTRY_EXISTS), or the list is full (code LIST_FULL)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.List))
  @Post()
  addEntry(@Param('listId') listId: string, @Body() dto: CreateListEntryDto) {
    return from(this.listEntryService.add(listId, dto)).pipe(
      map((entry) => ({ entry, message: t('success.list.entry_added') })),
    );
  }

  @ApiOperation({
    summary: "Update a list entry's note, priority or release (omitted fields preserved, null clears)",
    description: 'What the entry names is fixed: an entry for another game is a new entry.',
  })
  @ApiParam({ name: 'listId', type: String })
  @ApiParam({ name: 'entryId', type: String })
  @ApiResponse({ status: Http.Ok, type: ListEntryMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A priority off a wishlist (code LIST_PRIORITY_WISHLIST_ONLY), or a release that isn’t of the entry’s ' +
      'platform game (codes LIST_ENTRY_RELEASE_NEEDS_PLATFORM_GAME, LIST_ENTRY_RELEASE_MISMATCH)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'List not found (code LIST_NOT_FOUND), or no such entry on it (code LIST_ENTRY_NOT_FOUND)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.List))
  @Patch(':entryId')
  updateEntry(@Param('listId') listId: string, @Param('entryId') entryId: string, @Body() dto: UpdateListEntryDto) {
    return from(this.listEntryService.update(listId, entryId, dto)).pipe(
      map((entry) => ({ entry, message: t('success.list.entry_updated') })),
    );
  }

  @ApiOperation({ summary: 'Remove an entry from a list' })
  @ApiParam({ name: 'listId', type: String })
  @ApiParam({ name: 'entryId', type: String })
  @ApiResponse({ status: Http.Ok, type: ListEntryDeletedResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'List not found (code LIST_NOT_FOUND), or no such entry on it (code LIST_ENTRY_NOT_FOUND)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.List))
  @Delete(':entryId')
  removeEntry(@Param('listId') listId: string, @Param('entryId') entryId: string) {
    return from(this.listEntryService.remove(listId, entryId)).pipe(
      map(() => ({ message: t('success.list.entry_removed') })),
    );
  }
}
