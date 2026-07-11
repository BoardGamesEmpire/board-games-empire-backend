import type { FeedbackCategory } from '@bge/database';
import { Inject, Injectable } from '@nestjs/common';
import { FeedbackSinkMisconfiguredError, SinkNotRegisteredError } from '../contract/errors';
import type { FeedbackSink } from '../contract/feedback-sink';
import { FEEDBACK_SINKS } from '../contract/feedback-sink.tokens';

/**
 * Indexes the registered {@link FeedbackSink}s by `slug` and routes by the slug
 * recorded on a `FeedbackSubmission`. Duplicate slugs (or an empty registry)
 * fail loudly at construction; an unknown slug at resolve time throws
 * `SinkNotRegisteredError` rather than silently dropping a delivery. Mirrors
 * `StorageService`'s router (#100).
 *
 * `sinksAccepting()` is the fan-out entry point and the category-filter seam:
 * today it honours each sink's static `acceptsCategory()`; per-household sink
 * selection (`HouseholdFeedbackSinkConfig`) will layer on here once it lands.
 */
@Injectable()
export class FeedbackSinkRegistry {
  private readonly sinks: ReadonlyMap<string, FeedbackSink>;

  constructor(@Inject(FEEDBACK_SINKS) sinks: readonly FeedbackSink[]) {
    this.sinks = FeedbackSinkRegistry.indexBySlug(sinks);
  }

  /** Every registered sink slug, for logging/discovery. */
  get slugs(): readonly string[] {
    return [...this.sinks.keys()];
  }

  /**
   * Sinks that should receive a report of `category`, in registration order. A
   * sink with no `acceptsCategory` accepts every category.
   */
  sinksAccepting(category: FeedbackCategory): readonly FeedbackSink[] {
    return [...this.sinks.values()].filter((sink) => sink.acceptsCategory?.(category) ?? true);
  }

  /** Resolve a sink by its recorded slug, or throw `SinkNotRegisteredError`. */
  resolve(slug: string): FeedbackSink {
    const sink = this.sinks.get(slug);
    if (!sink) {
      throw new SinkNotRegisteredError(slug);
    }

    return sink;
  }

  private static indexBySlug(sinks: readonly FeedbackSink[]): ReadonlyMap<string, FeedbackSink> {
    if (sinks.length === 0) {
      throw new FeedbackSinkMisconfiguredError('No feedback sinks registered; at least the bundled local sink is required');
    }

    const map = new Map<string, FeedbackSink>();
    for (const sink of sinks) {
      if (map.has(sink.slug)) {
        throw new FeedbackSinkMisconfiguredError(`Duplicate feedback sink slug '${sink.slug}'`);
      }

      map.set(sink.slug, sink);
    }

    return map;
  }
}
