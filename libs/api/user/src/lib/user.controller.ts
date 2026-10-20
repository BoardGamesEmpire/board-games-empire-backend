import { AuthService } from '@bge/auth';
import { Action, ResourceType } from '@bge/database';
import { AbilityService, CheckPolicies, PoliciesGuard, resolveScopeSubjectId } from '@bge/permissions';
import { paginated, PaginatedResponseDto } from '@bge/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UserSearchQueryDto, UserSearchResultDto } from './dto';
import { UserService } from './user.service';

const PaginatedUsersResponse = PaginatedResponseDto(UserSearchResultDto, 'users');

@ApiTags('users')
@Controller('users')
export class UserController {
  constructor(
    private userService: UserService,
    private authService: AuthService,
    private abilityService: AbilityService,
  ) {}

  /**
   * The caller's own user: for a session, the user it belongs to, and for an
   * API key, the key's owner (#529). Read from the user's row, not the
   * session's copy of it, which is the row as it stood at sign-in.
   */
  @Get('me')
  me() {
    return from(this.authService.findUserById(this.abilityService.getActingUserId())).pipe(map((user) => ({ user })));
  }

  @ApiOperation({
    summary: 'Search searchable users by username, first name or display name',
    description:
      'Case-insensitive partial match, alphabetical by username. Excludes the acting user, banned accounts, ' +
      'anyone whose profile is not searchable, and anyone whose profile reach does not admit the acting ' +
      'user: a `Private` profile, and one that reaches friends when its owner is not their accepted friend. ' +
      'Paginated: `?page=` (1-based) and `?limit=` (default 10, max ' +
      '20 per page), with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`; `total` is ' +
      'the number of matches, so a client can say how deep the result set goes. The `q` the caller sent is ' +
      'no longer echoed in the body. See #230.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedUsersResponse })
  @UseGuards(PoliciesGuard)
  // Both types, because the response serves both: the rows are users, and each
  // carries its profile's display name and avatar. The read composes the
  // caller's ceiling on each, so a caller with no rule on either is refused
  // here rather than served an empty page.
  @CheckPolicies(
    (ability) => ability.can(Action.read, ResourceType.User),
    (ability) => ability.can(Action.read, ResourceType.UserProfile),
  )
  @Get('search')
  search(@Query() query: UserSearchQueryDto) {
    // No `search: query.q` alongside the rows any more (D-372-5): the caller
    // sent `q`, and a per-endpoint third field is how a shared envelope stops
    // being shared.
    return from(this.userService.searchUsers(resolveScopeSubjectId(this.abilityService), query)).pipe(
      map((page) => paginated('users', page, query, ResourceType.User)),
    );
  }
}
