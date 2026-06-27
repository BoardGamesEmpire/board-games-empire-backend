import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { QuotaModule } from '@bge/quota';
import { ServicesModule } from '@bge/services';
import { StorageModule } from '@bge/storage';
import { Module } from '@nestjs/common';
import { MediaContributionNotificationListener } from './listeners/media-contribution-notification.listener';
import { MediaContributionController } from './media-contribution.controller';
import { MediaContributionService } from './media-contribution.service';
import { MediaObjectController } from './media-object.controller';
import { MediaObjectService } from './media-object.service';
import { MediaStreamController } from './media-stream.controller';

@Module({
  imports: [DatabaseModule, StorageModule, QuotaModule, ServicesModule, NotificationsServiceModule],
  controllers: [MediaStreamController, MediaObjectController, MediaContributionController],
  providers: [MediaObjectService, MediaContributionService, MediaContributionNotificationListener],
  exports: [MediaObjectService, MediaContributionService],
})
export class MediaModule {}
