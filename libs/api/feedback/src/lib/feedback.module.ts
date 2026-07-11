import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { ServicesModule } from '@bge/services';
import { Module } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { FeedbackRetentionService } from './services/feedback-retention.service';
import { RedactionService } from './services/redaction.service';

/**
 * Feedback domain: persistence, redaction, retention, and the
 * `feedback.report.submitted` domain event. Sink fan-out (forwarding to
 * external destinations) lives in the `@bge/queue-feedback` producer/consumer —
 * it subscribes to that event, so adding sinks never touches this module.
 */
@Module({
  imports: [DatabaseModule, ServicesModule, PermissionsModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, RedactionService, FeedbackRetentionService],
  exports: [FeedbackService, FeedbackRetentionService],
})
export class FeedbackModule {}
