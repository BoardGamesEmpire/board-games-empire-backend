import { Action, ResourceType } from '@bge/database';
import { AbilityService, CheckPolicies, PoliciesGuard, resolveScopeSubjectId } from '@bge/permissions';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { MarkReadDto } from './dto/mark-read.dto';
import { UserNotificationsService } from './user-notifications.service';

/**
 * The acting user's own notifications. Each route's subject is the user behind
 * the actor, an API key's owner included; an actor with no user is refused
 * rather than shown an empty tray.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
// Must stay out of the response cache: the unread list is what a client polls,
// and it changes with each mark-read and each notification a worker writes. A
// cached body would repeat the list from before either for the whole TTL
// (#530).
@UseGuards(PoliciesGuard)
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: UserNotificationsService,
    private readonly abilityService: AbilityService,
  ) {}

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Notification))
  @Get('unread')
  async getUnread() {
    return this.notifications.getUnread(resolveScopeSubjectId(this.abilityService));
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Notification))
  @Post('mark-read')
  async markRead(@Body() markReadDto: MarkReadDto) {
    return this.notifications.markRead(resolveScopeSubjectId(this.abilityService), markReadDto.notificationIds);
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Notification))
  @Post('mark-all-read')
  async markAllRead() {
    return this.notifications.markAllRead(resolveScopeSubjectId(this.abilityService));
  }
}
