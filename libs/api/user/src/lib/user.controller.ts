import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { from, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { UserSearchQueryDto } from './dto/user-search-query.dto';
import { UserService } from './user.service';

@ApiTags('users')
@Controller('users')
@UseGuards(AuthGuard)
export class UserController {
  constructor(private userService: UserService) {}

  @Get('me')
  me(@Session() session: UserSession) {
    return of({ user: session?.user });
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.UserProfile))
  @Get('search')
  search(@Query() query: UserSearchQueryDto, @Session() session: UserSession) {
    return from(this.userService.searchUsers(session.user.id, query)).pipe(
      map((users) => ({
        users,
        search: query.q,
      })),
    );
  }
}
