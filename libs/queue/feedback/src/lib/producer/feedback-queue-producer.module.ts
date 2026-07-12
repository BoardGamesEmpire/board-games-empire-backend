import { AuditContextModule } from '@bge/actor-context';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FEEDBACK_QUEUE_NAME } from '../constants/feedback-queue.constants';
import { FeedbackSinkModule } from '../sinks/feedback-sink.module';
import { FeedbackDispatcherService } from './feedback-dispatcher.service';

/**
 * Producer end: the `feedback.report.submitted` listener that turns a persisted
 * report into queued deliveries. Registers the queue for enqueue only. Import in
 * the process that emits the event (the API). `FeedbackSinkModule` supplies the
 * registry the dispatcher consults to decide fan-out.
 */
@Module({
  imports: [AuditContextModule, FeedbackSinkModule, BullModule.registerQueue({ name: FEEDBACK_QUEUE_NAME })],
  providers: [FeedbackDispatcherService],
})
export class FeedbackQueueProducerModule {}
