import { Action, ResourceType } from '@bge/database';
import { t, type I18nPath } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CreateFriendRequestDto, ListFriendshipsQueryDto, RespondableFriendshipStatus, RespondFriendRequestDto } from './dto';
import { FriendshipService } from './friendship.service';

/**
 * Per-status success copy for `respond`. Each transition gets its own catalog
 * key so the returned message is a whole translatable sentence, rather than
 * interpolating an untranslated status word into a shared frame.
 */
const RESPOND_MESSAGE_KEYS = {
  [RespondableFriendshipStatus.Accepted]: 'success.friendship.accepted',
  [RespondableFriendshipStatus.Declined]: 'success.friendship.declined',
  [RespondableFriendshipStatus.Withdrawn]: 'success.friendship.withdrawn',
  [RespondableFriendshipStatus.Blocked]: 'success.friendship.blocked',
} as const satisfies Record<RespondableFriendshipStatus, I18nPath>;

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('friendships')
@Controller('friendships')
export class FriendshipController {
  constructor(private readonly friendshipService: FriendshipService) {}

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Friendship))
  @Post()
  create(@Body() createFriendRequestDto: CreateFriendRequestDto) {
    return from(this.friendshipService.create(createFriendRequestDto)).pipe(
      map((friendship) => ({ message: t('success.friendship.created'), friendship })),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Friendship))
  @Get()
  list(@Query() query: ListFriendshipsQueryDto) {
    return from(this.friendshipService.listForUser(query)).pipe(map((friendships) => ({ friendships })));
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Friendship))
  @Get('requests')
  listRequests(@Query() query: ListFriendshipsQueryDto) {
    return from(this.friendshipService.listIncomingRequests(query)).pipe(map((requests) => ({ requests })));
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Friendship))
  @Patch(':id')
  respond(@Param('id') id: string, @Body() respondFriendRequestDto: RespondFriendRequestDto) {
    return from(this.friendshipService.respond(id, respondFriendRequestDto.status)).pipe(
      map((friendship) => ({ message: t(RESPOND_MESSAGE_KEYS[respondFriendRequestDto.status]), friendship })),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.Friendship))
  @Delete(':id')
  remove(@Param('id') id: string) {
    return from(this.friendshipService.remove(id)).pipe(
      map(() => ({ message: t('success.friendship.removed', { id }) })),
    );
  }
}
