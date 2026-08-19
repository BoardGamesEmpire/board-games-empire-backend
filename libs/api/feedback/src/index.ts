export { FeedbackEvents, type FeedbackEvent } from './lib/constants/feedback-events.constant';
export * from './lib/feedback.module';
// Per-user feedback throttler registered into the global ThrottlerModule by the
// API app (the IP tier reuses the built-in `default` throttler; see #45).
export type {
  FeedbackReportPurgedEvent,
  FeedbackReportSubmittedEvent,
  FeedbackReportTriagedEvent,
  UserFeedbackBannedEvent,
  UserFeedbackUnbannedEvent,
} from './lib/interfaces/feedback.interface';
export { DEFAULT_THROTTLER_NAME, USER_THROTTLER_NAME, createUserThrottler } from './lib/throttling/feedback-throttler';
