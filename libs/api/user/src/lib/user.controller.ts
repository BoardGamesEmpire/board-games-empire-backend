import { AuthService, type AuthUser } from '@bge/auth';
import { Action, ResourceType } from '@bge/database';
import {
  AbilityService,
  type ActorAccess,
  CheckPolicies,
  PoliciesGuard,
  resolveScopeSubjectId,
} from '@bge/permissions';
import { paginated, PaginatedResponseDto } from '@bge/shared';
import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { UserAccessEnvelopeDto, UserAccessQueryDto, UserSearchQueryDto, UserSearchResultDto } from './dto';
import { UserService } from './user.service';

const PaginatedUsersResponse = PaginatedResponseDto(UserSearchResultDto, 'users');

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- `image` is destructured only to leave it out
function withoutProviderPicture({ image: _image, ...user }: AuthUser): Omit<AuthUser, 'image'> {
  return user;
}

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
   *
   * Without `image`, the sign-in provider's picture: it only seeds the avatar
   * at provisioning, and the avatar is the profile's (#695). better-auth's own
   * session routes still carry `image`, since they serve better-auth's user
   * shape.
   */
  @Get('me')
  me(): Observable<{ user: Omit<AuthUser, 'image'> | null }> {
    return from(this.authService.findUserById(this.abilityService.getActingUserId())).pipe(
      map((user) => ({ user: user === null ? null : withoutProviderPicture(user) })),
    );
  }

  /**
   * What the acting actor may do with each resource type it names (#757), so a
   * client can hide what the server would refuse. No policy check guards it:
   * every actor may ask about itself, and an actor with no permissions is
   * answered `none` everywhere.
   *
   * `no-store`, because a cached answer goes stale in exactly the moments a
   * client needs it fresh: just after a role is granted or removed, and just
   * after sign-up.
   */
  @ApiOperation({
    summary: 'What the acting actor may do with each resource type named',
    description:
      'For each resource type named in `resourceTypes`, answers each action (`create`, `read`, `update`, ' +
      "`delete` and `manage`) as the server's own checks decide it. `all`: the actor may act on every record. " +
      '`some`: the actor may act on some records, or on some of their fields, and the server decides each ' +
      'request by its conditions or with a 403. `none`: a route that checks that action on that resource ' +
      'type refuses the request. A route that runs no such check, such as reading your own user, is not ' +
      'covered by the answer. A client shows an action for `all` or `some` and hides it for `none`, and ' +
      'never checks a condition itself. For an API ' +
      'key, the answer covers the key and its owner together: each action gets the narrower of the two. A ' +
      'grant that covers only some fields answers `some`, unless another grant covers every field, and so ' +
      'does a denial of a single field. A grant of `manage` answers for every action, but holding the other ' +
      'four never answers `manage`. A resource type named twice is answered once. Straight after sign-up, ' +
      "the new user's roles may not be written yet, so ask again before trusting a `none`. The response is " +
      'never cached (`Cache-Control: no-store`), so a role change shows at once. See #757.',
  })
  @ApiResponse({
    status: Http.Ok,
    type: UserAccessEnvelopeDto,
    description: "The acting actor's access to each resource type named.",
  })
  @Header('Cache-Control', 'no-store')
  @Get('me/access')
  access(@Query() query: UserAccessQueryDto): { access: ActorAccess } {
    return { access: this.abilityService.getCurrentAccess(query.resourceTypes) };
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
