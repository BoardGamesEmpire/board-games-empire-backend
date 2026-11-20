import { diag } from '@opentelemetry/api';
import { timerDelayFromEnv } from './env-number';

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
 * The timing `initOtel` gave its metric reader, once it has built one.
 * `BullMQQueueDepthRecorder` reads this rather than the environment, so it
 * polls on the reader's cycle even when `.env` is loaded after `initOtel`
 * has run, as ConfigModule does outside production (#1436).
 */
let pinnedTiming: MetricExportTiming | undefined;

/**
 * Reads `OTEL_METRIC_EXPORT_INTERVAL` and `OTEL_METRIC_EXPORT_TIMEOUT`.
 *
 * NodeSDK reads these vars only for readers it builds itself; `initOtel`
 * passes its own reader, so it must pass them along (#1436). A missing or
 * blank value falls back to the SDK default quietly. A value that isn't a
 * number of milliseconds from 1 to 2147483647 falls back with a `diag`
 * warning: Node runs a timer outside that range every millisecond.
 *
 * The timeout is limited to the interval: `PeriodicExportingMetricReader`
 * throws when the timeout is longer, so setting only a short interval
 * would otherwise crash startup against the 30000 ms default timeout. As
 * in the SDK's own env reader, the limit is a `diag` warning when the
 * operator set both values, and `diag` info when one is a default.
 */
export function resolveMetricExportTiming(env: NodeJS.ProcessEnv = process.env): MetricExportTiming {
  const interval = timerDelayFromEnv(env, OTEL_METRIC_EXPORT_INTERVAL_ENV);
  const timeout = timerDelayFromEnv(env, OTEL_METRIC_EXPORT_TIMEOUT_ENV);
  const exportIntervalMillis = interval ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS;
  const exportTimeoutMillis = timeout ?? DEFAULT_METRIC_EXPORT_TIMEOUT_MS;

  if (exportTimeoutMillis <= exportIntervalMillis) {
    return { exportIntervalMillis, exportTimeoutMillis };
  }

  const describe = (value: number | undefined, fallback: number): string => value?.toString() ?? `${fallback}, default`;
  const message =
    `${OTEL_METRIC_EXPORT_TIMEOUT_ENV} (${describe(timeout, DEFAULT_METRIC_EXPORT_TIMEOUT_MS)}) is longer than ` +
    `${OTEL_METRIC_EXPORT_INTERVAL_ENV} (${describe(interval, DEFAULT_METRIC_EXPORT_INTERVAL_MS)}); ` +
    'using the interval as the timeout.';
  if (interval !== undefined && timeout !== undefined) {
    diag.warn(message);
  } else {
    diag.info(message);
  }

  return { exportIntervalMillis, exportTimeoutMillis: exportIntervalMillis };
}

/**
 * Records the timing the metric reader runs on. Called by `initOtel` when it
 * builds the reader; `undefined` clears it.
 */
export function pinMetricExportTiming(timing: MetricExportTiming | undefined): void {
  pinnedTiming = timing;
}

/**
 * The timing the metric reader runs on: the one `initOtel` pinned, or, when
 * no reader has been built in this process, the environment's.
 */
export function metricExportTiming(): MetricExportTiming {
  return pinnedTiming ?? resolveMetricExportTiming();
}
