export const OTEL_METRIC_EXPORT_INTERVAL_ENV = 'OTEL_METRIC_EXPORT_INTERVAL';
export const OTEL_METRIC_EXPORT_TIMEOUT_ENV = 'OTEL_METRIC_EXPORT_TIMEOUT';

/** `PeriodicExportingMetricReader`'s own defaults, per the OTel SDK spec. */
export const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
export const DEFAULT_METRIC_EXPORT_TIMEOUT_MS = 30_000;

export interface MetricExportTiming {
  readonly exportIntervalMillis: number;
  readonly exportTimeoutMillis: number;
}

/**
 * Reads `OTEL_METRIC_EXPORT_INTERVAL` and `OTEL_METRIC_EXPORT_TIMEOUT`.
 * Consulted by `resolveMetricReader` and `BullMQQueueDepthRecorder`, so
 * queue depth is polled on the same cycle the reader exports (#1436).
 *
 * NodeSDK reads these vars only for readers it builds itself; `initOtel`
 * passes its own reader, so it must pass them along. A missing, empty,
 * non-numeric, infinite or non-positive value falls back to the SDK default.
 *
 * The timeout is limited to the interval: `PeriodicExportingMetricReader`
 * throws when the timeout is longer, so setting only a short interval
 * would otherwise crash startup against the 30000 ms default timeout.
 */
export function resolveMetricExportTiming(env: NodeJS.ProcessEnv = process.env): MetricExportTiming {
  const exportIntervalMillis =
    readPositiveNumber(env[OTEL_METRIC_EXPORT_INTERVAL_ENV]) ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS;
  const exportTimeoutMillis = Math.min(
    readPositiveNumber(env[OTEL_METRIC_EXPORT_TIMEOUT_ENV]) ?? DEFAULT_METRIC_EXPORT_TIMEOUT_MS,
    exportIntervalMillis,
  );

  return { exportIntervalMillis, exportTimeoutMillis };
}

/**
 * Parses the way the SDK's `getNumberFromEnv` does, with `Number` rather
 * than `parseInt`: `10000ms` falls back instead of reading as `10000`, and
 * `5.5` is kept whole instead of truncated to `5`.
 */
function readPositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
