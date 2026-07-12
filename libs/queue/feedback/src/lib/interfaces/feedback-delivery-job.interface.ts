/**
 * One delivery job = one (report, sink) pair. Kept intentionally thin: the
 * consumer re-reads the `FeedbackReport` by id at delivery time rather than
 * freezing a copy here, so redaction/edits applied after submission are always
 * reflected and the job payload can't drift from the row.
 *
 * Actor + correlation ride in the `__meta` envelope (via `wrapJobData`), not in
 * this payload — the consumer runs on `ActorAwareWorkerHost`, which reconstructs
 * the CLS scope from that envelope.
 */
export interface FeedbackDeliveryJob {
  /** The report being forwarded. Re-read from the DB by the consumer. */
  readonly feedbackReportId: string;

  /** Slug of the sink this job delivers to; resolved via `FeedbackSinkRegistry`. */
  readonly sinkSlug: string;
}
