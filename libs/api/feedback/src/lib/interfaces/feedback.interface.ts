import type { FeedbackCategory, FeedbackContext, FeedbackSeverity, FeedbackStatus } from '@bge/database';

/**
 * Domain event payloads. All carry enough identifying context for listeners
 * to act without re-querying — keeps listeners cheap and reduces N+1 risk.
 */

export interface FeedbackReportSubmittedEvent {
  readonly feedbackReportId: string;
  readonly submittedById: string;
  readonly category: FeedbackCategory;
  readonly context: FeedbackContext;
  readonly severity: FeedbackSeverity | null;
}

export interface FeedbackReportTriagedEvent {
  readonly feedbackReportId: string;
  readonly triagedById: string;
  readonly previousStatus: FeedbackStatus;
  readonly newStatus: FeedbackStatus;
}

export interface FeedbackReportPurgedEvent {
  readonly purgedCount: number;
  readonly olderThan: Date;
}

export interface UserFeedbackBannedEvent {
  readonly userId: string;
  readonly bannedById: string;
  readonly reason: string | null;
  readonly expiresAt: Date | null;
}

export interface UserFeedbackUnbannedEvent {
  readonly userId: string;
  readonly unbannedById: string;
}
