/**
 * Base class for feedback-sink errors. Carries a stable `code` for mapping at
 * the edge. Mirrors the storage-contract error hierarchy.
 */
export abstract class FeedbackSinkError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No sink is registered for a recorded `sinkSlug`. */
export class SinkNotRegisteredError extends FeedbackSinkError {
  readonly code = 'SINK_NOT_REGISTERED';

  constructor(
    readonly slug: string,
    options?: { cause?: unknown },
  ) {
    super(`No feedback sink registered for slug '${slug}'`, options);
  }
}

/** The sink set is invalid (duplicate slug, empty registry). Fails at construction. */
export class FeedbackSinkMisconfiguredError extends FeedbackSinkError {
  readonly code = 'FEEDBACK_SINK_MISCONFIGURED';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
