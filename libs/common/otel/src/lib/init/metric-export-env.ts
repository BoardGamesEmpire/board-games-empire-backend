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
 * non-numeric or non-positive value falls back to the SDK default.
 *
 * The timeout is limited to the interval: `PeriodicExportingMetricReader`
 * throws when the timeout is longer, so setting only a short interval
 * would otherwise crash startup against the 30000 ms default timeout.
 */
export function resolveMetricExportTiming(env: NodeJS.ProcessEnv = process.env): MetricExportTiming {
  const exportIntervalMillis =
    readPositiveInt(env[OTEL_METRIC_EXPORT_INTERVAL_ENV]) ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS;
  const exportTimeoutMillis = Math.min(
    readPositiveInt(env[OTEL_METRIC_EXPORT_TIMEOUT_ENV]) ?? DEFAULT_METRIC_EXPORT_TIMEOUT_MS,
    exportIntervalMillis,
  );

  return { exportIntervalMillis, exportTimeoutMillis };
}

function readPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
