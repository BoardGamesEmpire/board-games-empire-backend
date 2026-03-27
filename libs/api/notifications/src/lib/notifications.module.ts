import { NotificationsServiceModule } from '@bge/notifications-service';
import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';

@Module({
  controllers: [NotificationsController],
  imports: [NotificationsServiceModule],
})
export class NotificationsModule {}
