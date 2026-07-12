import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FEEDBACK_QUEUE_NAME } from '../constants/feedback-queue.constants';
import { FeedbackSinkModule } from '../sinks/feedback-sink.module';
import { FeedbackDeliveryProcessor } from './feedback-delivery.processor';
import { FeedbackDeliveryService } from './feedback-delivery.service';

/**
 * Consumer end of the feedback delivery queue. Imported by the worker app only.
 * Registering the same queue name here attaches the BullMQ worker; the producer
 * module (API side) registers it for enqueue. `FeedbackSinkModule` supplies the
 * registry the delivery service resolves sinks through; `AuditContextModule`
 * satisfies the `ActorAwareWorkerHost` CLS requirement.
 */
@Module({
  imports: [AuditContextModule, DatabaseModule, FeedbackSinkModule, BullModule.registerQueue({ name: FEEDBACK_QUEUE_NAME })],
  providers: [FeedbackDeliveryService, FeedbackDeliveryProcessor],
  exports: [FeedbackDeliveryService],
})
export class FeedbackQueueConsumerModule {}
