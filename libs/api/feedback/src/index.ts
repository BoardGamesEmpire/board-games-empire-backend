export * from './lib/feedback.module';
export { FeedbackEvents, type FeedbackEvent } from './lib/constants/feedback-events.constant';
export type {
  FeedbackReportSubmittedEvent,
  FeedbackReportPurgedEvent,
  FeedbackReportTriagedEvent,
  UserFeedbackBannedEvent,
  UserFeedbackUnbannedEvent,
} from './lib/interfaces/feedback.interface';
