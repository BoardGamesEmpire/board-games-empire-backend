import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueNames } from './constants/queue.constants';
import { NotificationListener } from './listeners/notification.listener';
import { GameFetchProcessor } from './processors/game-fetch.processor';
import { ImportBatchCompletionService } from './services/batch-completion.service';

/**
 * Fetch-side module. Imported by apps/gateway-worker. Owns the BullMQ
 * processor for GameFetch / ExpansionFetch jobs. Depends on the globally-
 * available GatewayRegistryService for actual gateway access.
 *
 * NotificationListener runs here as well as in the consumer module: fetch
 * failures emit JobFailed in THIS process, and the in-process event bus
 * doesn't cross process boundaries. Guarded terminal transitions ensure a
 * failure is emitted exactly once across the two processes, so dual
 * registration cannot duplicate notifications.
 */
@Module({
  imports: [
    AuditContextModule,
    DatabaseModule,
    NotificationsServiceModule,
    // Consumer-side registration only. Retry/backoff and removeOn* are set at
    // PRODUCE time on the flow nodes (FETCH_JOB_OPTS in import-flow.builder) —
    // `defaultJobOptions` here would be a silent no-op, since fetch jobs are
    // produced by the coordinator's / worker's FlowProducer, not through this
    // Queue instance.
    BullModule.registerQueue({ name: QueueNames.GatewayFetch }),
  ],
  providers: [GameFetchProcessor, ImportBatchCompletionService, NotificationListener],
})
export class GameImportFetchModule {}
