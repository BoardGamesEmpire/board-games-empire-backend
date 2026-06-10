import { OTEL_EXPORTER_OTLP_ENDPOINT_ENV, OTEL_METRICS_EXPORTER_ENV } from './otel.config';

/**
 * Env var selecting a per-signal OTLP endpoint for metrics. When set,
 * the OTLPMetricExporter uses it in preference to the general
 * {@link OTEL_EXPORTER_OTLP_ENDPOINT_ENV}. Per the OTel SDK spec, this
 * overrides the general endpoint for metric data only.
 */
export const OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT';

/**
 * Single source of truth for "is OTel metrics export actually
 * configured?" — consulted by:
 *
 * - `resolveMetricReader` in `init-otel.ts` (whether to register a
 *   `PeriodicExportingMetricReader` with the NodeSDK)
 * - `createBullMQTelemetry` (whether to pass `enableMetrics: true` to
 *   `BullMQOtel`, which controls whether a meter is created)
 * - `BullMQQueueDepthRecorder` (whether to start the polling timer)
 *
 * All three must agree. If `createBullMQTelemetry` enables metrics
 * while `resolveMetricReader` skips the reader, the bullmq-otel meter
 * has no exporter and the recorder polls Redis with nothing to record
 * to. The duplicated local copies of this check (which previously lived
 * in each caller) drifted out of sync — the helper exists to make that
 * impossible.
 *
 * Returns true if and only if BOTH:
 *
 * - `OTEL_METRICS_EXPORTER === 'otlp'` — explicit opt-in. BGE's
 *   `defaultSignalExporters` sets this to `'none'` when unset, so the
 *   operator must opt in deliberately.
 * - Either `OTEL_EXPORTER_OTLP_ENDPOINT` or the per-signal
 *   `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is set (non-empty).
 *
 * Non-`otlp` values (`prometheus`, `console`, …) are not supported by
 * BGE — `@bge/otel` deliberately bypasses NodeSDK's auto-configuration
 * of non-OTLP exporters, so allowing them through here would create
 * meters with no actual exporter behind them.
 *
 * Takes an explicit `env` parameter (defaulting to `process.env`) so
 * tests can pass deterministic objects without mutating global state.
 */
export function metricsExportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[OTEL_METRICS_EXPORTER_ENV] !== 'otlp') {
    return false;
  }
  // `||` rather than `??` so an empty-string endpoint is treated as
  // unset — matches operator intent ("blank means I forgot to set it")
  // and aligns with how the OTLP exporters interpret an empty endpoint.
  return Boolean(env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV] || env[OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV]);
}
