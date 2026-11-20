import {
  OTEL_METRIC_EXPORT_INTERVAL_ENV,
  OTEL_METRIC_EXPORT_TIMEOUT_ENV,
  resolveMetricExportTiming,
} from './metric-export-env';

describe('resolveMetricExportTiming', () => {
  it('returns the SDK defaults when both vars are unset', () => {
    expect(resolveMetricExportTiming({})).toEqual({ exportIntervalMillis: 60_000, exportTimeoutMillis: 30_000 });
  });

  it('reads both vars when they are valid', () => {
    const env: NodeJS.ProcessEnv = {
      [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '90000',
      [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: '45000',
    };

    expect(resolveMetricExportTiming(env)).toEqual({ exportIntervalMillis: 90_000, exportTimeoutMillis: 45_000 });
  });

  it.each(['', '   ', 'not-a-number', '0', '-5', '10000ms', '5.5s', 'Infinity'])(
    'falls back to the defaults for %p',
    (raw) => {
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRIC_EXPORT_INTERVAL_ENV]: raw,
        [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: raw,
      };

      expect(resolveMetricExportTiming(env)).toEqual({ exportIntervalMillis: 60_000, exportTimeoutMillis: 30_000 });
    },
  );

  // Parsed the way the SDK parses its own env vars (`Number`, not
  // `parseInt`): a unit suffix falls back rather than being read as its
  // numeric prefix, and a decimal is kept rather than truncated (#1436).
  it('reads a decimal value whole, as the SDK does', () => {
    const env: NodeJS.ProcessEnv = {
      [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '10000.5',
      [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: '5.5',
    };

    expect(resolveMetricExportTiming(env)).toEqual({ exportIntervalMillis: 10_000.5, exportTimeoutMillis: 5.5 });
  });

  it('limits the default timeout to a shorter interval, since the reader throws otherwise (#1436)', () => {
    const env: NodeJS.ProcessEnv = { [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '10000' };

    expect(resolveMetricExportTiming(env)).toEqual({ exportIntervalMillis: 10_000, exportTimeoutMillis: 10_000 });
  });

  it('limits an explicit timeout to the interval (#1436)', () => {
    const env: NodeJS.ProcessEnv = {
      [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '15000',
      [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: '20000',
    };

    expect(resolveMetricExportTiming(env)).toEqual({ exportIntervalMillis: 15_000, exportTimeoutMillis: 15_000 });
  });
});
