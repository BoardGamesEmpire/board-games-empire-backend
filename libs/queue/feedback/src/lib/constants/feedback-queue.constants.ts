/**
 * Transport-layer constants for the feedback delivery queue — how submissions
 * move through BullMQ, not the feedback domain. Domain constants (event names)
 * stay in `@bge/feedback`.
 */

/** BullMQ queue carrying one job per (report, sink) delivery. */
export const FEEDBACK_QUEUE_NAME = 'feedback-delivery';

/** Single job name on the delivery queue. */
export const FEEDBACK_DELIVERY_JOB = 'deliver';

/** Default BullMQ attempts per delivery job (exponential backoff between them). */
export const FEEDBACK_DELIVERY_ATTEMPTS = 5;

/** Base backoff in ms for the delivery job's exponential retry. */
export const FEEDBACK_DELIVERY_BACKOFF_MS = 2_000;

/**
 * How many terminally-failed delivery jobs to retain in Redis (newest-first).
 * Bounds the failed set while leaving a recent tail for inspection.
 */
export const FEEDBACK_FAILED_JOB_RETENTION = 1_000;

/** Cap on the `lastError` text persisted on a `FeedbackSubmission` row. */
export const FEEDBACK_LAST_ERROR_MAX_LENGTH = 1_000;
