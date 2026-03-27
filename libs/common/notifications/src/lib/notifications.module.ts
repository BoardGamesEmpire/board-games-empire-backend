import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [DatabaseModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsServiceModule {}
