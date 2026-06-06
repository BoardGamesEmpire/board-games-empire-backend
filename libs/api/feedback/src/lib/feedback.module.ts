import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { ServicesModule } from '@bge/services';
import { Module } from '@nestjs/common';
import { FeedbackDispatcherService } from './feedback-dispatcher.service';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { FeedbackRetentionService } from './services/feedback-retention.service';
import { RedactionService } from './services/redaction.service';

@Module({
  imports: [DatabaseModule, ServicesModule, PermissionsModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, RedactionService, FeedbackDispatcherService, FeedbackRetentionService],
  exports: [FeedbackService, FeedbackRetentionService],
})
export class FeedbackModule {}
