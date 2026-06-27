import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { StorageModule } from '@bge/storage';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MediaQueueNames } from '../constants/media-queue.constants';
import { MediaContributionPurgeProcessor } from './purge.processor';
import { MediaContributionPurgeService } from './purge.service';
import { MediaContributionSweepService } from './sweep.service';

/**
 * Worker-only. Hosts the periodic sweep dispatcher (@Interval) and the purge
 * processor for the same queue — registering it here enables both enqueue and
 * consume. Requires the host to register ScheduleModule.forRoot() + a global
 * ClsModule (the worker does both).
 */
@Module({
  imports: [
    AuditContextModule,
    DatabaseModule,
    StorageModule,
    NotificationsServiceModule,
    BullModule.registerQueue({ name: MediaQueueNames.ContributionSweep }),
  ],
  providers: [MediaContributionSweepService, MediaContributionPurgeService, MediaContributionPurgeProcessor],
  exports: [MediaContributionSweepService],
})
export class MediaSweepModule {}
