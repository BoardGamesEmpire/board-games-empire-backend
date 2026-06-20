import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { WebhooksModule } from '@bge/webhooks';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WEBHOOK_QUEUE_NAME } from '../constants/webhook-queue.constants';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * Producer end: the onAny dispatcher that turns locally-emitted domain events
 * into queued deliveries. Registers the queue for enqueue only. Import in any
 * process that emits eligible events (API today; worker for game events later).
 */
@Module({
  imports: [
    AuditContextModule,
    DatabaseModule,
    PermissionsModule,
    BullModule.registerQueue({ name: WEBHOOK_QUEUE_NAME }),
    WebhooksModule,
  ],
  providers: [WebhookDispatcherService],
})
export class WebhookQueueProducerModule {}
