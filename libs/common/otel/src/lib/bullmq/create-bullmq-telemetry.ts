import { BullMQOtel } from 'bullmq-otel';
import { OTEL_EXPORTER_NONE, OTEL_METRICS_EXPORTER_ENV } from '../init/otel.config';

/**
 * Configuration for {@link createBullMQTelemetry}.
 */
export interface CreateBullMQTelemetryOptions {
  /**
   * OTel tracer/meter name. Populates `instrumentation_scope.name` on
   * every span produced by BullMQ telemetry. Defaults to `'bullmq'`,
   * matching bullmq-otel's own default and the convention for
   * identifying spans produced by BullMQ instrumentation.
   *
   * You almost certainly don't want to change this. The deployed
   * service identity is conveyed via the resource `service.name`
   * attribute (configured globally in `bootstrapObservability`), not
   * the tracer name. Using the service name here would mislead
   * tooling that filters by instrumentation library.
   */
  tracerName?: string;

  /**
   * Optional version string written to `instrumentation_scope.version`
   * on every span. Useful for tracking which version of the
   * instrumentation library produced a given span when correlating
   * issues with upgrades.
   */
  version?: string;
}

/**
 * Constructs a `BullMQOtel` instance wired to the globally-registered
 * OTel tracer and meter providers (set up by `initOtel` /
 * `bootstrapObservability`). Pass the return value to BullMQ's
 * `QueueOptions.telemetry` / `WorkerOptions.telemetry`:
 *
 * ```ts
 * BullModule.forRootAsync({
 *   inject: [QUEUE_REDIS_CLIENT],
 *   useFactory: (queueClient: RedisClient) => ({
 *     connection: queueClient,
 *     telemetry: createBullMQTelemetry(),
 *   }),
 * });
 * ```
 *
 * What this gives you, automatically:
 *
 * - **Trace context propagation** across the queue boundary. BullMQ
 *   captures the active OTel context at `queue.add` time and restores
 *   it at job processing time, so spans produced inside the worker
 *   become children of the producer's span.
 *
 * - **Lifecycle spans** wrapping `add`, `getJob`, processing, and
 *   other Queue/Worker operations.
 *
 * - **Job-level metrics** (counters for completed/failed/delayed/
 *   retried/waiting/waiting_children; histogram for job duration) when
 *   `OTEL_METRICS_EXPORTER=otlp`. Queue depth gauge values are
 *   recorded via {@link BullMQQueueDepthRecorder}, which calls
 *   `queue.recordJobCountsMetric()` on a timer.
 *
 * ## Activation matrix
 *
 * `enableMetrics` is opted into automatically when
 * `OTEL_METRICS_EXPORTER=otlp`. When the env var is unset or `'none'`
 * (the @bge/otel default — see {@link OTEL_METRICS_EXPORTER_ENV}),
 * the returned telemetry instance still propagates trace context and
 * produces lifecycle spans, but does not register any meter, so all
 * `meter.createCounter(...)` calls become no-ops.
 *
 * NOTE: this check intentionally duplicates the logic in
 * {@link resolveMetricReader} in `init-otel.ts`. Both must agree on
 * what "metrics enabled" means; consolidate if the activation matrix
 * grows. Today it's a single env-var check.
 */
export function createBullMQTelemetry(options: CreateBullMQTelemetryOptions = {}): BullMQOtel {
  return new BullMQOtel({
    tracerName: options.tracerName ?? 'bullmq',
    meterName: options.tracerName ?? 'bullmq',
    version: options.version,
    enableMetrics: metricsExportEnabled(),
  });
}

/**
 * Returns true when the operator has opted into metrics export via
 * `OTEL_METRICS_EXPORTER=otlp`. Mirrors the activation check in
 * `resolveMetricReader`.
 */
function metricsExportEnabled(): boolean {
  const exporter = process.env[OTEL_METRICS_EXPORTER_ENV];
  return exporter !== undefined && exporter !== OTEL_EXPORTER_NONE && exporter !== '';
}
