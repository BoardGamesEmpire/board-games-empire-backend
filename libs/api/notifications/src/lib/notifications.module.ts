import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { UserNotificationsService } from './user-notifications.service';

@Module({
  controllers: [NotificationsController],
  // The composer and the ability service come from the global PermissionsModule.
  imports: [DatabaseModule],
  providers: [UserNotificationsService],
})
export class NotificationsModule {}
