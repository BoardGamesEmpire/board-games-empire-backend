import { Module } from '@nestjs/common';
import type { FeedbackSink } from '../contract/feedback-sink';
import { FEEDBACK_SINKS } from '../contract/feedback-sink.tokens';
import { FeedbackSinkRegistry } from './feedback-sink.registry';
import { LocalDatabaseSink } from './local-database.sink';

/**
 * Shared sink runtime: the set of registered {@link FeedbackSink}s and the
 * registry that routes by slug. Imported by BOTH the producer (API — to decide
 * fan-out) and the consumer (worker — to invoke `submit()`), so the two
 * processes agree on which sinks exist.
 *
 * Each concrete sink is a normal provider, then aggregated into `FEEDBACK_SINKS`
 * via `useFactory` — the same registration idiom as `STORAGE_DRIVERS`. v1 ships
 * one sink (the bundled local sink); plugin sinks register here as they land
 * (#59). The registry enforces the no-duplicate-slug / non-empty invariants at
 * construction.
 */
@Module({
  providers: [
    LocalDatabaseSink,
    {
      provide: FEEDBACK_SINKS,
      inject: [LocalDatabaseSink],
      useFactory: (local: LocalDatabaseSink): readonly FeedbackSink[] => [local],
    },
    FeedbackSinkRegistry,
  ],
  exports: [FeedbackSinkRegistry],
})
export class FeedbackSinkModule {}
