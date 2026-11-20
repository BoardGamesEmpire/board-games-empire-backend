import type { FeedbackCategory, FeedbackContext, FeedbackSeverity, FeedbackStatus } from '@bge/database';

/**
 * Domain event payloads. All carry enough identifying context for listeners
 * to act without re-querying — keeps listeners cheap and reduces N+1 risk.
 */

export interface FeedbackReportSubmittedEvent {
  readonly category: FeedbackCategory;
  readonly context: FeedbackContext;
  readonly feedbackReportId: string;
  readonly severity: FeedbackSeverity | null;
  readonly submittedById: string;
}

export interface FeedbackReportTriagedEvent {
  readonly feedbackReportId: string;
  readonly newStatus: FeedbackStatus;
  readonly previousStatus: FeedbackStatus;
  readonly triagedById: string;
}

export interface FeedbackReportPurgedEvent {
  readonly olderThan: Date;
  readonly purgedCount: number;
}

export interface UserFeedbackBannedEvent {
  readonly bannedById: string;
  readonly expiresAt: Date | null;
  readonly reason: string | null;
  readonly userId: string;
}

export interface UserFeedbackUnbannedEvent {
  readonly unbannedById: string;
  readonly userId: string;
}
