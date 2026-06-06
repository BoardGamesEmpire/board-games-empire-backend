/**
 * Domain event names emitted by the feedback feature. Listeners (feedback dispatcher,
 * notifications, audit log) subscribe via `@OnEvent`.
 */
export const FeedbackEvents = {
  FeedbackReportSubmitted: 'feedback.report.submitted',
  FeedbackReportTriaged: 'feedback.report.triaged',
  FeedbackReportPurged: 'feedback.report.purged',
  UserFeedbackBanned: 'feedback.user.banned',
  UserFeedbackUnbanned: 'feedback.user.unbanned',
} as const;

export type FeedbackEvent = (typeof FeedbackEvents)[keyof typeof FeedbackEvents];
