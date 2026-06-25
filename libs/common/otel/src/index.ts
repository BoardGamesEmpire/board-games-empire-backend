export { BGE_OTEL_ATTRIBUTES } from './lib/constants/otel-attributes.constants';

export { initOtel, type OtelBootstrapHandle } from './lib/init/init-otel';
export {
  OTEL_EXPORTER_NONE,
  OTEL_LOGS_EXPORTER_ENV,
  OTEL_METRICS_EXPORTER_ENV,
  type OtelInitConfig,
} from './lib/init/otel.config';

// Span processors
export {
  noopActorContextProvider,
  type ActorContextProvider,
  type ActorSpanContext,
} from './lib/processors/actor-context-provider';
export { ActorSpanProcessor } from './lib/processors/actor-span.processor';

// Pino integration
export { buildOtelPinoOptions, otelTraceMixin } from './lib/pino/otel-pino.options';

// Bootstrap helpers
export { bootstrapObservability } from './lib/bootstrap/bootstrap-observability';
export { createShutdown, registerShutdownHandlers } from './lib/bootstrap/register-shutdown';

// BullMQ integration. `createBullMQTelemetry` wraps the bullmq-otel
// package — pass the return value to `BullModule.forRoot`'s `telemetry`
// option. BullMQ then handles trace context propagation, lifecycle
// spans, and (when metrics are enabled) job-level counters and the
// duration histogram automatically. The queue depth gauge is driven
// by `BullMQQueueDepthRecorderModule`, which periodically calls
// `queue.recordJobCountsMetric()` on every discovered Queue.
export { BullMQQueueDepthRecorderModule } from './lib/bullmq/bullmq-queue-depth-recorder.module';
export { BullMQQueueDepthRecorder } from './lib/bullmq/bullmq-queue-depth-recorder.service';
export { createBullMQTelemetry, type CreateBullMQTelemetryOptions } from './lib/bullmq/create-bullmq-telemetry';

// Database connection-pool metrics. Import `DbPoolMetricsRecorderModule`
// at the app root alongside `DatabaseModule`; the recorder discovers any
// `DatabasePoolMetricsSource` and bridges pg pool gauges to OTel.
export { DbPoolMetricsRecorderModule } from './lib/database/pool-metrics-recorder.module';
export { DbPoolMetricsRecorder } from './lib/database/pool-metrics-recorder.service';
export {
  isDatabasePoolMetricsSource,
  type DatabasePoolMetricsSnapshot,
  type DatabasePoolMetricsSource,
} from './lib/database/pool-metrics-source';
