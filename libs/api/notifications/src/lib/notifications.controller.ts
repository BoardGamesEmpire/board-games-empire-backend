import { NotificationsService } from '@bge/notifications-service';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { MarkReadDto } from './dto/mark-read.dto';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('unread')
  async getUnread(@Session() session: UserSession) {
    return this.notificationsService.getUnread(session.user.id);
  }

  @Post('mark-read')
  async markRead(@Session() session: UserSession, @Body() markReadDto: MarkReadDto) {
    return this.notificationsService.markRead(session.user.id, markReadDto.notificationIds);
  }

  @Post('mark-all-read')
  async markAllRead(@Session() session: UserSession) {
    return this.notificationsService.markAllRead(session.user.id);
  }
}
