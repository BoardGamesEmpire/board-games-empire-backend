import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { paginated, PaginatedResponseDto } from '@bge/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { AdminHouseholdListQueryDto } from './admin-household-list.query.dto';
import { AdminHouseholdRowResponse } from './admin-household-row.response';
import { AdminHouseholdService } from './admin-household.service';

/**
 * The staff households list (#419): every household on the server, live or
 * deleted, for the admin dashboard. Mounted under `admin/`, apart from the
 * household routes, whose lists answer for the acting user's own households.
 *
 * Read only. A row's detail is `GET /households/:id`, and a deleted row's
 * restore is `POST /households/:id/restore`, both of which staff already
 * reach.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('admin-households')
@Controller('admin/households')
export class AdminHouseholdController {
  constructor(private readonly adminHouseholds: AdminHouseholdService) {}

  @ApiOperation({
    summary: 'List every household on the server, for staff and the Owner',
    description:
      'Every household on the server, whoever its members are. `status` picks which: `live` (the default), ' +
      '`deleted`, or `all`. `q`, at least 2 characters once surrounding spaces are trimmed, keeps the ' +
      'households whose name, or a member’s username or display name, contains it, ignoring case; `%`, `_` ' +
      'and `\\` in it match only themselves, and a household matched through several members is listed once. ' +
      'A search that matches nothing is an empty page, not a 404. `sort` orders the list: `name` (A to Z, the ' +
      'default), `newest` (most recently created first), `members` (most members first) or `deleted` (most ' +
      'recently deleted first). Every order ends in the household id, so a repeated request answers the same ' +
      'page while the set is unchanged. `sort=deleted` needs `status=deleted` or `status=all`, and under ' +
      '`status=all` live households come after every deleted one. Each row is lean: it counts the members and ' +
      'names only the household owners, which for a deleted household are its owners as they stood at the ' +
      'delete. Read a live household’s detail at `GET /households/:id`, and restore a deleted one at ' +
      '`POST /households/:id/restore`. Paginated: `?page=` (1-based) and `?limit=`, with a `pagination` ' +
      'envelope carrying `total`, `totalPages` and `hasMore` (#230). See #419.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedResponseDto(AdminHouseholdRowResponse, 'households') })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'An unknown status or sort, a search term shorter than 2 characters, or sort=deleted with status live ' +
      '(the default)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'The actor can’t read every resource on the server. Only staff and the Owner can, and an API key only ' +
      'when its key scopes allow it as well',
  })
  // `read` on `all`, not on Household. Every user reads Household, so that
  // gate would let in a user with only the base role, and the ceiling would
  // answer them their own households: a quiet 200 where the client counts on a
  // 403 to leave the admin section. Narrowing the staff read to what each
  // surface needs is #518.
  @CheckPolicies((ability) => ability.can(Action.read, 'all'))
  @Get()
  listHouseholds(@Query() query: AdminHouseholdListQueryDto) {
    return from(this.adminHouseholds.listHouseholds(query)).pipe(
      map((page) => paginated('households', page, query, ResourceType.Household)),
    );
  }
}
