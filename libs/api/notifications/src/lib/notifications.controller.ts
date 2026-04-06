import { Action, ResourceType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { MarkReadDto } from './dto/mark-read.dto';

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Notification))
  @Get('unread')
  async getUnread(@Session() session: UserSession) {
    return this.notificationsService.getUnread(session.user.id);
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Notification))
  @Post('mark-read')
  async markRead(@Session() session: UserSession, @Body() markReadDto: MarkReadDto) {
    return this.notificationsService.markRead(session.user.id, markReadDto.notificationIds);
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Notification))
  @Post('mark-all-read')
  async markAllRead(@Session() session: UserSession) {
    return this.notificationsService.markAllRead(session.user.id);
  }
}
