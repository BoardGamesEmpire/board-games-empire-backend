import { Action, ResourceType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { AbilityService, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { NoCache } from '@bge/shared';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { MarkReadDto } from './dto/mark-read.dto';

@ApiBearerAuth()
@ApiSecurity('api_key')
// Never response-cached: the unread list is what a client polls, and it
// changes with each mark-read and each notification a worker writes. A cached
// body would repeat the list from before either for the whole TTL (#530).
@NoCache()
@UseGuards(PoliciesGuard)
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly abilityService: AbilityService,
  ) {}

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Notification))
  @Get('unread')
  async getUnread() {
    return this.notificationsService.getUnread(this.abilityService.getActingUserId());
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Notification))
  @Post('mark-read')
  async markRead(@Body() markReadDto: MarkReadDto) {
    return this.notificationsService.markRead(this.abilityService.getActingUserId(), markReadDto.notificationIds);
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Notification))
  @Post('mark-all-read')
  async markAllRead() {
    return this.notificationsService.markAllRead(this.abilityService.getActingUserId());
  }
}
