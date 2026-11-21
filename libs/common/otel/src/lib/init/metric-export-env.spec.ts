import type { DiagLogger } from '@opentelemetry/api';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  metricExportTiming,
  OTEL_METRIC_EXPORT_INTERVAL_ENV,
  OTEL_METRIC_EXPORT_TIMEOUT_ENV,
  pinMetricExportTiming,
  resolveMetricExportTiming,
} from './metric-export-env';

const DEFAULTS = { exportIntervalMillis: 60_000, exportTimeoutMillis: 30_000 };

const diagLogger: jest.Mocked<DiagLogger> = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  verbose: jest.fn(),
  warn: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  diag.setLogger(diagLogger, DiagLogLevel.ALL);
});

afterEach(() => {
  diag.disable();
  pinMetricExportTiming(undefined);
});

describe('resolveMetricExportTiming', () => {
  it('returns the SDK defaults when both vars are unset', () => {
    expect(resolveMetricExportTiming({})).toEqual(DEFAULTS);
    expect(diagLogger.warn).not.toHaveBeenCalled();
  });

  it('reads both vars when they are valid', () => {
    const env: NodeJS.ProcessEnv = {
      [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '90000',
      [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: '45000',
    };

    expect(resolveMetricExportTiming(env)).toEqual({ exportIntervalMillis: 90_000, exportTimeoutMillis: 45_000 });
  });

  it.each(['', '   '])('falls back to the defaults quietly for the blank value %p', (raw) => {
    const env: NodeJS.ProcessEnv = {
      [OTEL_METRIC_EXPORT_INTERVAL_ENV]: raw,
      [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: raw,
    };

    expect(resolveMetricExportTiming(env)).toEqual(DEFAULTS);
    expect(diagLogger.warn).not.toHaveBeenCalled();
  });

  // An operator who sets a value and gets the default instead should be
  // told so, as the SDK tells them for its own variables (#1436).
  it.each(['not-a-number', '0', '-5', '10000ms', '5.5s', 'Infinity'])(
    'falls back to the defaults for %p and warns about each variable',
    (raw) => {
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRIC_EXPORT_INTERVAL_ENV]: raw,
        [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: raw,
      };

      expect(resolveMetricExportTiming(env)).toEqual(DEFAULTS);
      expect(diagLogger.warn).toHaveBeenCalledTimes(2);
      expect(diagLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`${OTEL_METRIC_EXPORT_INTERVAL_ENV} (${raw})`),
      );
      expect(diagLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`${OTEL_METRIC_EXPORT_TIMEOUT_ENV} (${raw})`),
      );
    },
  );

  // Node runs a timer whose delay is below 1 or above 2147483647 every
  // millisecond, which would export metrics and poll every queue a thousand
  // times a second (#1436).
  it.each(['0.5', '2147483648', '3000000000'])('rejects the out-of-range timer delay %p with a warning', (raw) => {
    const env: NodeJS.ProcessEnv = {
      [OTEL_METRIC_EXPORT_INTERVAL_ENV]: raw,
      [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: raw,
    };

    expect(resolveMetricExportTiming(env)).toEqual(DEFAULTS);
    expect(diagLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('accepts the longest delay Node honours (#1436)', () => {
    const env: NodeJS.ProcessEnv = { [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '2147483647' };

    expect(resolveMetricExportTiming(env).exportIntervalMillis).toBe(2_147_483_647);
    expect(diagLogger.warn).not.toHaveBeenCalled();
  });

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

  // As the SDK's own env reader does: info, not a warning, when the timeout
  // that's too long is the default rather than the operator's (#1436).
  it('limits the default timeout to a shorter interval, since the reader throws otherwise, and logs it as info', () => {
    const env: NodeJS.ProcessEnv = { [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '10000' };

    expect(resolveMetricExportTiming(env)).toEqual({ exportIntervalMillis: 10_000, exportTimeoutMillis: 10_000 });
    expect(diagLogger.warn).not.toHaveBeenCalled();
    expect(diagLogger.info).toHaveBeenCalledWith(
      `${OTEL_METRIC_EXPORT_TIMEOUT_ENV} (30000, default) is longer than ${OTEL_METRIC_EXPORT_INTERVAL_ENV} (10000); ` +
        'using the interval as the timeout.',
    );
  });

  // Both values are the operator's, so cutting one down is worth a warning,
  // as the SDK's own env reader gives (#1436).
  it('limits an explicit timeout to the interval and warns', () => {
    const env: NodeJS.ProcessEnv = {
      [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '15000',
      [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: '20000',
    };

    expect(resolveMetricExportTiming(env)).toEqual({ exportIntervalMillis: 15_000, exportTimeoutMillis: 15_000 });
    expect(diagLogger.warn).toHaveBeenCalledWith(
      `${OTEL_METRIC_EXPORT_TIMEOUT_ENV} (20000) is longer than ${OTEL_METRIC_EXPORT_INTERVAL_ENV} (15000); ` +
        'using the interval as the timeout.',
    );
  });

  it('does not log when the timeout already fits the interval', () => {
    const env: NodeJS.ProcessEnv = {
      [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '15000',
      [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: '15000',
    };

    resolveMetricExportTiming(env);

    expect(diagLogger.warn).not.toHaveBeenCalled();
    expect(diagLogger.info).not.toHaveBeenCalled();
  });

  // The real reader, not a mock: it throws when its timeout is longer than
  // its interval, so this proves the limit keeps a short interval from
  // crashing startup (#1436).
  it.each([
    ['only a short interval', { [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '10000' }],
    [
      'a timeout longer than the interval',
      { [OTEL_METRIC_EXPORT_INTERVAL_ENV]: '1000', [OTEL_METRIC_EXPORT_TIMEOUT_ENV]: '5000' },
    ],
  ])('builds a real PeriodicExportingMetricReader from %s', (_case, env: NodeJS.ProcessEnv) => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

    expect(() => new PeriodicExportingMetricReader({ exporter, ...resolveMetricExportTiming(env) })).not.toThrow();
  });
});

describe('metricExportTiming', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[OTEL_METRIC_EXPORT_INTERVAL_ENV];
    delete process.env[OTEL_METRIC_EXPORT_TIMEOUT_ENV];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('reads the environment when nothing is pinned', () => {
    process.env[OTEL_METRIC_EXPORT_INTERVAL_ENV] = '20000';

    expect(metricExportTiming()).toEqual({ exportIntervalMillis: 20_000, exportTimeoutMillis: 20_000 });
  });

  // `initOtel` pins the reader's timing; `.env` can be loaded into the
  // environment after that, and must not split polling from export (#1436).
  it('returns the pinned timing even when the environment changed since', () => {
    pinMetricExportTiming({ exportIntervalMillis: 10_000, exportTimeoutMillis: 5_000 });
    process.env[OTEL_METRIC_EXPORT_INTERVAL_ENV] = '20000';

    expect(metricExportTiming()).toEqual({ exportIntervalMillis: 10_000, exportTimeoutMillis: 5_000 });
  });

  it('reads the environment again once the pin is cleared', () => {
    pinMetricExportTiming({ exportIntervalMillis: 10_000, exportTimeoutMillis: 5_000 });
    pinMetricExportTiming(undefined);

    expect(metricExportTiming()).toEqual(DEFAULTS);
  });
});
