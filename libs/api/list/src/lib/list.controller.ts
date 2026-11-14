import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto, paginated } from '@bge/shared';
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  CreateListDto,
  ListDeletedResponseDto,
  ListMessageResponseDto,
  ListResponseDto,
  ListsResponseDto,
  PaginatedListResponse,
  ReorderListsDto,
  UpdateListDto,
} from './dto';
import { ListService } from './list.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('lists')
// Must stay out of the response cache: a client reorders or renames a list and
// re-reads it to reconcile, so a stale read within the cache TTL is a
// correctness bug, not an optimization trade-off.
@UseGuards(PoliciesGuard)
@Controller('lists')
export class ListController {
  constructor(private readonly listService: ListService) {}

  @ApiOperation({
    summary: "List the acting user's lists",
    description:
      'In the order the user chose, the wishlist among them. Paginated: `?page=` (1-based) and `?limit=`, with a ' +
      '`pagination` envelope carrying `total`, `totalPages` and `hasMore`.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedListResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.List))
  @Get()
  getOwnLists(@Query() query: DefaultPaginationQueryDto) {
    return from(this.listService.listOwn(query)).pipe(
      map((page) => paginated('lists', page, query, ResourceType.List)),
    );
  }

  @ApiOperation({
    summary: "Replace the order of the acting user's lists",
    description:
      'Send every one of your list ids, first to last. Positions are renumbered from 0 in that order. A request ' +
      'that is not exactly the lists you hold now is refused with code `LIST_ORDER_STALE` and changes nothing. ' +
      'The request must be able to change every one of your lists: an API key that may change only some of them ' +
      'is refused with code `LIST_ORDER_FORBIDDEN`. ' +
      'Declared before the `:id` routes, so `order` is never taken for an id.',
  })
  @ApiResponse({ status: Http.Ok, type: ListsResponseDto })
  @ApiResponse({ status: Http.BadRequest, description: 'Duplicate ids, or more ids than a user can hold' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'Insufficient permissions, or permission to change only some of your lists (code LIST_ORDER_FORBIDDEN)',
  })
  @ApiResponse({ status: Http.Conflict, description: 'Not exactly your lists (code LIST_ORDER_STALE)' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.List))
  @Put('order')
  reorderLists(@Body() dto: ReorderListsDto) {
    return from(this.listService.reorder(dto)).pipe(map((lists) => ({ lists })));
  }

  @ApiOperation({ summary: 'Get a single list' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: ListResponseDto })
  @ApiResponse({ status: Http.NotFound, description: 'List not found (code LIST_NOT_FOUND)' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.List))
  @Get(':id')
  getList(@Param('id') id: string) {
    return from(this.listService.getById(id)).pipe(map((list) => ({ list })));
  }

  @ApiOperation({
    summary: 'Create a custom list',
    description: 'Added after the acting user’s last list, `Private` unless a reach is given.',
  })
  @ApiResponse({ status: Http.Created, type: ListMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The user holds the most lists allowed (code LIST_LIMIT_REACHED)',
  })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.List))
  @Post()
  createList(@Body() dto: CreateListDto) {
    return from(this.listService.create(dto)).pipe(map((list) => ({ list, message: t('success.list.created') })));
  }

  @ApiOperation({
    summary: 'Update a list (omitted fields preserved, null clears)',
    description: 'Only a wishlist accepts `name: null`; a custom list answers code `LIST_NAME_REQUIRED`.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: ListMessageResponseDto })
  @ApiResponse({ status: Http.BadRequest, description: 'A custom list without a name (code LIST_NAME_REQUIRED)' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'List not found (code LIST_NOT_FOUND)' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.List))
  @Patch(':id')
  updateList(@Param('id') id: string, @Body() dto: UpdateListDto) {
    return from(this.listService.update(id, dto)).pipe(map((list) => ({ list, message: t('success.list.updated') })));
  }

  @ApiOperation({
    summary: 'Delete a custom list',
    description: 'Its entries go with it. A wishlist is refused with code `WISHLIST_UNDELETABLE`.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, type: ListDeletedResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'List not found (code LIST_NOT_FOUND)' })
  @ApiResponse({ status: Http.Conflict, description: 'The list is a wishlist (code WISHLIST_UNDELETABLE)' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.List))
  @Delete(':id')
  deleteList(@Param('id') id: string) {
    return from(this.listService.remove(id)).pipe(map(() => ({ message: t('success.list.deleted') })));
  }
}
