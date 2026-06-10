import { Logger } from '@nestjs/common';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BGE_OTEL_ATTRIBUTES } from '../constants/otel-attributes.constants';
import type { ActorContextProvider } from './actor-context-provider';

/**
 * OpenTelemetry {@link SpanProcessor} that stamps BGE-specific
 * actor / correlation / household attributes onto every span at
 * `onStart`.
 *
 * The audit context snapshot is pulled from an injected
 * {@link ActorContextProvider} so this processor stays decoupled from
 * `@bge/actor-context`'s CLS internals. The provider returns an empty
 * snapshot when no audit context is active — typical for spans created
 * pre-NestFactory and for synthetic spans in tests.
 *
 * PII policy enforcement: this processor NEVER reads `userId`,
 * `apiKeyId`, or the `identifier` field of `external` actors, even when
 * the provider returns an actor that exposes them. The complete
 * allow-list of emitted attributes lives in
 * {@link BGE_OTEL_ATTRIBUTES} — changes there require a PII review.
 *
 * Lifecycle:
 * - `onStart` stamps attributes (this is the only meaningful behavior)
 * - `onEnd` is intentionally a no-op — attributes ride the span through to
 *   export, no second pass needed
 * - `shutdown` / `forceFlush` resolve immediately because this processor
 *   owns no buffered state; an upstream {@link BatchSpanProcessor} is
 *   responsible for flushing exporters
 *
 * Failure isolation: if the provider throws, the processor logs a warning
 * and skips annotation rather than letting the failure propagate into the
 * tracing pipeline. A broken audit context must not break tracing.
 */
export class ActorSpanProcessor implements SpanProcessor {
  private readonly logger = new Logger(ActorSpanProcessor.name);

  constructor(private readonly provider: ActorContextProvider) {}

  onStart(span: Span, _parentContext: Context): void {
    let snapshot;
    try {
      snapshot = this.provider();
    } catch (error) {
      this.logger.warn(`Actor context provider threw — span will not be annotated: ${(error as Error).message}`);
      return;
    }

    const { actor, correlationId, householdId } = snapshot;
    if (actor) {
      span.setAttribute(BGE_OTEL_ATTRIBUTES.ACTOR_KIND, actor.kind);

      if (actor.kind === 'plugin') {
        span.setAttribute(BGE_OTEL_ATTRIBUTES.ACTOR_PLUGIN_ID, actor.pluginId);
        span.setAttribute(BGE_OTEL_ATTRIBUTES.ACTOR_TRIGGER_KIND, actor.trigger.kind);
      } else if (actor.kind === 'external') {
        span.setAttribute(BGE_OTEL_ATTRIBUTES.ACTOR_EXTERNAL_SYSTEM, actor.system);
      }
    }

    if (householdId) {
      span.setAttribute(BGE_OTEL_ATTRIBUTES.HOUSEHOLD_ID, householdId);
    }

    if (correlationId) {
      span.setAttribute(BGE_OTEL_ATTRIBUTES.CORRELATION_ID, correlationId);
    }
  }

  onEnd(_span: ReadableSpan): void {
    // No-op — attributes are stamped at start and ride the span through.
  }

  async shutdown(): Promise<void> {
    // No buffered state to flush.
  }

  async forceFlush(): Promise<void> {
    // No buffered state to flush.
  }
}
