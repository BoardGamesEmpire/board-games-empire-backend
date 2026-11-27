import { Action, ResourceType } from '@bge/database';
import type { NotificationDto } from '@bge/notifications-service';
import { AbilityService, CheckPolicies, PoliciesGuard, resolveScopeSubjectId } from '@bge/permissions';
import type { CursorPaginatedResponse } from '@bge/shared';
import { ApiCursorPaginatedEnvelope, cursorPaginated } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { ListNotificationsQueryDto } from './dto/list-notifications.query.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import { UnreadCountDto } from './dto/unread-count.dto';
import { MAX_UNREAD_NOTIFICATIONS } from './notifications.constants';
import { UserNotificationsService } from './user-notifications.service';

/**
 * The acting user's own notifications. Each route's subject is the user behind
 * the actor, an API key's owner included; an actor with no user is refused
 * rather than shown an empty tray.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
// Must stay out of the response cache: the unread list and the unread count are
// what a client polls, and the history list is what it reads right after a
// mark-read. Each changes with every mark-read and every notification a worker
// writes, so a cached body would repeat the one from before either for the
// whole TTL (#530, #1597).
@UseGuards(PoliciesGuard)
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: UserNotificationsService,
    private readonly abilityService: AbilityService,
  ) {}

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Notification))
  @Get('unread')
  async getUnread() {
    return this.notifications.getUnread(resolveScopeSubjectId(this.abilityService));
  }

  @ApiCursorPaginatedEnvelope('notifications', {
    description: "A page of the acting user's notification history, read and unread, newest first",
  })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'The query failed validation, naming each field: cursor not one a previous page returned, or limit ' +
      'not a positive whole number within the maximum, or a parameter it does not take, such as page',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Notification))
  @Get()
  async list(
    @Query() query: ListNotificationsQueryDto,
  ): Promise<CursorPaginatedResponse<'notifications', NotificationDto>> {
    const page = await this.notifications.list(resolveScopeSubjectId(this.abilityService), {
      after: query.after,
      pageSize: query.pageSize,
    });

    return cursorPaginated('notifications', page, query, ResourceType.Notification);
  }

  // A route of its own rather than a field on `/unread`'s response: `/unread`
  // answers with the list and this answers with a number (#1597).
  @ApiResponse({
    status: Http.Ok,
    type: UnreadCountDto,
    description: 'How many unread notifications the acting user has, uncapped',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Notification))
  @Get('unread/count')
  async countUnread(): Promise<UnreadCountDto> {
    const count = await this.notifications.countUnread(resolveScopeSubjectId(this.abilityService));

    return { count };
  }

  @ApiResponse({ status: Http.Ok, description: 'Named notifications marked read' })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'The body failed validation, naming each field: notificationIds missing, not strings or more than ' +
      `${MAX_UNREAD_NOTIFICATIONS}, or a field it does not take, such as userId`,
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Notification))
  // Both mark routes mark rows that exist and create none, so 200 (#584).
  // Nest's default for a POST is 201.
  @HttpCode(Http.Ok)
  @Post('mark-read')
  async markRead(@Body() markReadDto: MarkReadDto) {
    return this.notifications.markRead(resolveScopeSubjectId(this.abilityService), markReadDto.notificationIds);
  }

  @ApiResponse({ status: Http.Ok, description: 'All notifications marked read' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Notification))
  @HttpCode(Http.Ok)
  @Post('mark-all-read')
  async markAllRead() {
    return this.notifications.markAllRead(resolveScopeSubjectId(this.abilityService));
  }
}
