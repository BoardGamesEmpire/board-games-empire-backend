export * from './lib/feedback.module';
export { FeedbackEvents, type FeedbackEvent } from './lib/constants/feedback-events.constant';
// Per-user feedback throttler registered into the global ThrottlerModule by the
// API app (the IP tier reuses the built-in `default` throttler; see #45).
export { createUserThrottler } from './lib/throttling/feedback-throttler';
export type {
  FeedbackReportSubmittedEvent,
  FeedbackReportPurgedEvent,
  FeedbackReportTriagedEvent,
  UserFeedbackBannedEvent,
  UserFeedbackUnbannedEvent,
} from './lib/interfaces/feedback.interface';
