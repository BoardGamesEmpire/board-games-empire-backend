import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WEBHOOK_QUEUE_NAME } from '../constants/webhook-queue.constants';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * Producer end: the onAny dispatcher that turns locally-emitted domain events
 * into queued deliveries. Registers the queue for enqueue only. Import in any
 * process that emits eligible events (API today; worker for game events later).
 * Relies on the global WebhooksModule for the registry + visibility check.
 */
@Module({
  imports: [DatabaseModule, PermissionsModule, BullModule.registerQueue({ name: WEBHOOK_QUEUE_NAME })],
  providers: [WebhookDispatcherService],
})
export class WebhookQueueProducerModule {}
