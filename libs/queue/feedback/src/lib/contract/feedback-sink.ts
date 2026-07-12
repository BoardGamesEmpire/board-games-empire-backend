import type { FeedbackCategory, FeedbackReport, FeedbackSubmission, Prisma } from '@bge/database';

/**
 * A destination a feedback report can be forwarded to. The bundled
 * {@link LocalDatabaseSink} is the canonical reference implementation; external
 * sinks (GitHub Issues, Discord, Sentry, …) arrive as plugins once the loader
 * lands (#59). Implementations own only the forwarding — the queue owns fan-out,
 * retry, per-sink failure isolation, and the `FeedbackSubmission` audit row.
 *
 * Implementations MUST:
 *  - expose a stable `slug` (persisted on `FeedbackSubmission.sinkSlug`)
 *  - be idempotent on retry: `submit()` may be called again for the same report
 *    after a transient failure, so avoid creating duplicate external artifacts
 *    (use the report id / `SinkContext.submissionId` as the external idempotency key)
 *  - throw on failure so BullMQ counts the attempt; never swallow-and-return
 */
export interface FeedbackSink {
  /** Stable identifier, e.g. 'local'. Persisted on `FeedbackSubmission.sinkSlug`. */
  readonly slug: string;

  /**
   * True for in-tree sinks that ship with the server (currently only the local
   * database sink). Informational — surfaced by discovery endpoints (#78) and a
   * hint that the sink cannot be uninstalled.
   */
  readonly bundled?: boolean;

  /**
   * Category filter hook. When present, the dispatcher only routes reports whose
   * category this returns `true` for (e.g. bugs → GitHub, feature requests →
   * Discord). Absent means "accept every category". This is the seam that
   * per-household sink selection (`HouseholdFeedbackSinkConfig`) will consult
   * once it lands; until then it is a per-sink static filter.
   */
  acceptsCategory?(category: FeedbackCategory): boolean;

  /**
   * Forward one report to this sink. Resolves with the external identifiers to
   * record on the `FeedbackSubmission`; throws on any failure so the queue
   * records the attempt and eventually surfaces a terminal failure.
   */
  submit(report: FeedbackReport, context: SinkContext): Promise<SinkSubmissionResult>;

  /**
   * Pull the latest state of a previously-submitted item back from the external
   * system (e.g. a GitHub issue was closed). Optional and unimplemented for now
   * — the contract exists so bidirectional sync is purely additive later
   * (deferred, see the sink-sync follow-up issue).
   */
  syncStatus?(submission: FeedbackSubmission): Promise<SinkSubmissionResult>;
}

/**
 * Per-attempt context handed to a sink. Deliberately small; external sinks that
 * need more (household, plugin config) will extend this as those land.
 */
export interface SinkContext {
  /** The `FeedbackSubmission` row this delivery attempt writes its outcome to. */
  readonly submissionId: string;
}

/**
 * What a sink returns on a successful `submit()` / `syncStatus()`. All fields are
 * optional: the bundled local sink has no meaningful external handle, whereas an
 * issue-tracker sink returns the issue number + URL.
 */
export interface SinkSubmissionResult {
  /** External identifier (issue number, ticket id, message id). */
  readonly externalId?: string | null;

  /** Link back to the external item, for admin/triage UIs. */
  readonly externalUrl?: string | null;

  /** Sink-specific extras persisted verbatim on `FeedbackSubmission.metadata`. */
  readonly metadata?: Prisma.InputJsonValue | null;
}
