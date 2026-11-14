import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto, paginated } from '@bge/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { PaginatedListResponse } from './dto';
import { ListService } from './list.service';

/**
 * Another user's lists, addressed under that user (#1241), the way their
 * collection is (#514).
 *
 * Its own class rather than a handler on `UserController`: that would make the
 * user lib import this one, and feature libs don't import each other.
 *
 * Must stay out of the response cache. The rows are someone else's and the
 * viewer's access to them can change without the viewer doing anything: an
 * unfriending, or the owner making a list Private, would otherwise go unseen
 * for the cache TTL.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('lists')
@UseGuards(PoliciesGuard)
@Controller('users/:userId/lists')
export class UserListsController {
  constructor(private readonly listService: ListService) {}

  @ApiOperation({
    summary: "List another user's visible lists",
    description:
      'The lists you may see, by each list’s reach: what reaches the owner’s friends when you are one, what ' +
      'reaches friends of friends or the owner’s extended network when you are that close and no block stands ' +
      'between you, and what is `Public`. Signed-in users only: an anonymous user holds no list permission and ' +
      'gets 403.',
  })
  @ApiParam({ name: 'userId', type: String })
  @ApiResponse({ status: Http.Ok, type: PaginatedListResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.List))
  @Get()
  getUserLists(@Param('userId') userId: string, @Query() query: DefaultPaginationQueryDto) {
    return from(this.listService.listForUser(userId, query)).pipe(
      map((page) => paginated('lists', page, query, ResourceType.List)),
    );
  }
}
