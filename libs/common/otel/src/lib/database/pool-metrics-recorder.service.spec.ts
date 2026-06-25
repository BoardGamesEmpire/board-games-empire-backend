// Mock the OTel API so we can assert instrument creation and capture the
// batch-observe callback without a real meter provider. getMeter returns
// a stable meter object; createObservableGauge returns a `{ name }` stub
// so observations can be matched by metric name.
jest.mock('@opentelemetry/api', () => {
  const createObservableGauge = jest.fn((name: string) => ({ name }));
  const addBatchObservableCallback = jest.fn();
  const removeBatchObservableCallback = jest.fn();
  const meter = { createObservableGauge, addBatchObservableCallback, removeBatchObservableCallback };
  return { metrics: { getMeter: jest.fn(() => meter) } };
});

import { Logger } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { metrics } from '@opentelemetry/api';
import { OTEL_EXPORTER_NONE, OTEL_EXPORTER_OTLP_ENDPOINT_ENV, OTEL_METRICS_EXPORTER_ENV } from '../init/otel.config';
import { DbPoolMetricsRecorder } from './pool-metrics-recorder.service';
import type { DatabasePoolMetricsSnapshot, DatabasePoolMetricsSource } from './pool-metrics-source';

const METER_NAME = 'bge-database-pool';

interface MockMeter {
  readonly createObservableGauge: jest.Mock;
  readonly addBatchObservableCallback: jest.Mock;
  readonly removeBatchObservableCallback: jest.Mock;
}

interface GaugeStub {
  readonly name: string;
}

interface FakeBatchResult {
  readonly observe: jest.Mock<void, [GaugeStub, number]>;
}

type CapturedCallback = (result: FakeBatchResult) => void;

const getMockMeter = (): MockMeter => metrics.getMeter(METER_NAME) as unknown as MockMeter;

const restoreEnvVar = (name: string, original: string | undefined): void => {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
};

const buildSource = (
  snapshot: DatabasePoolMetricsSnapshot,
): DatabasePoolMetricsSource & {
  getDatabasePoolMetrics: jest.Mock<DatabasePoolMetricsSnapshot, []>;
} => ({
  getDatabasePoolMetrics: jest.fn<DatabasePoolMetricsSnapshot, []>(() => snapshot),
});

const buildDiscoveryService = (sources: DatabasePoolMetricsSource[]): DiscoveryService => {
  const wrappers: Array<Pick<InstanceWrapper, 'instance'>> = sources.map((source) => ({
    instance: source as unknown,
  }));
  // A non-source provider to verify the recorder filters by the contract.
  wrappers.push({ instance: { someOtherService: true } as unknown });

  return {
    getProviders: jest.fn(() => wrappers as InstanceWrapper[]),
  } as unknown as DiscoveryService;
};

// The recorder registers exactly one batch callback; retrieve it to drive
// a collection by hand (OTel would call it at export time).
const captureCallback = (): CapturedCallback => {
  const meter = getMockMeter();
  expect(meter.addBatchObservableCallback).toHaveBeenCalledTimes(1);
  return meter.addBatchObservableCallback.mock.calls[0][0] as CapturedCallback;
};

describe('DbPoolMetricsRecorder', () => {
  let originalMetricsExporter: string | undefined;
  let originalEndpoint: string | undefined;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    originalMetricsExporter = process.env[OTEL_METRICS_EXPORTER_ENV];
    originalEndpoint = process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];

    // Default: metrics enabled (exporter opt-in + endpoint configured).
    process.env[OTEL_METRICS_EXPORTER_ENV] = 'otlp';
    process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV] = 'http://localhost:4318';

    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    restoreEnvVar(OTEL_METRICS_EXPORTER_ENV, originalMetricsExporter);
    restoreEnvVar(OTEL_EXPORTER_OTLP_ENDPOINT_ENV, originalEndpoint);
  });

  describe('idle states', () => {
    it('registers no callback when OTEL_METRICS_EXPORTER is unset', () => {
      delete process.env[OTEL_METRICS_EXPORTER_ENV];
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([buildSource(snapshot())]));

      recorder.onApplicationBootstrap();

      expect(getMockMeter().addBatchObservableCallback).not.toHaveBeenCalled();
    });

    it('registers no callback when OTEL_METRICS_EXPORTER is "none"', () => {
      process.env[OTEL_METRICS_EXPORTER_ENV] = OTEL_EXPORTER_NONE;
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([buildSource(snapshot())]));

      recorder.onApplicationBootstrap();

      expect(getMockMeter().addBatchObservableCallback).not.toHaveBeenCalled();
    });

    it('registers no callback when no OTLP endpoint is configured', () => {
      delete process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([buildSource(snapshot())]));

      recorder.onApplicationBootstrap();

      expect(getMockMeter().addBatchObservableCallback).not.toHaveBeenCalled();
    });

    it('registers no callback when no pool-metrics source is discovered', () => {
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([]));

      recorder.onApplicationBootstrap();

      expect(getMockMeter().addBatchObservableCallback).not.toHaveBeenCalled();
    });
  });

  describe('instrument registration', () => {
    it('creates the five pool gauges and registers one batch callback', () => {
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([buildSource(snapshot())]));

      recorder.onApplicationBootstrap();

      const meter = getMockMeter();
      expect(meter.createObservableGauge.mock.calls.map((call) => call[0])).toEqual([
        'db.pool.connections.open',
        'db.pool.connections.busy',
        'db.pool.connections.idle',
        'db.pool.connections.pending',
        'db.pool.connections.max',
      ]);
      expect(meter.addBatchObservableCallback).toHaveBeenCalledTimes(1);
      // Second arg is the list of observed instruments.
      expect(meter.addBatchObservableCallback.mock.calls[0][1]).toHaveLength(5);
    });
  });

  describe('observation', () => {
    it('observes a single source snapshot, ignoring non-source providers', () => {
      const source = buildSource({ open: 7, busy: 5, idle: 2, pending: 1, max: 10 });
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([source]));
      recorder.onApplicationBootstrap();

      const callback = captureCallback();
      const result: FakeBatchResult = { observe: jest.fn() };
      callback(result);

      expect(source.getDatabasePoolMetrics).toHaveBeenCalledTimes(1);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.open' }), 7);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.busy' }), 5);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.idle' }), 2);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.pending' }), 1);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.max' }), 10);
    });

    it('sums snapshots across multiple sources', () => {
      const a = buildSource({ open: 4, busy: 3, idle: 1, pending: 0, max: 10 });
      const b = buildSource({ open: 6, busy: 2, idle: 4, pending: 5, max: 20 });
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([a, b]));
      recorder.onApplicationBootstrap();

      const result: FakeBatchResult = { observe: jest.fn() };
      captureCallback()(result);

      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.open' }), 10);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.busy' }), 5);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.idle' }), 5);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.pending' }), 5);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.max' }), 30);
    });
  });

  describe('failure isolation', () => {
    it('skips a throwing source and still observes the healthy one', () => {
      const failing = buildSource(snapshot());
      failing.getDatabasePoolMetrics.mockImplementation(() => {
        throw new Error('pool read failed');
      });
      const healthy = buildSource({ open: 3, busy: 1, idle: 2, pending: 0, max: 10 });
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([failing, healthy]));
      recorder.onApplicationBootstrap();

      const result: FakeBatchResult = { observe: jest.fn() };
      captureCallback()(result);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(result.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.open' }), 3);
      expect(result.observe).toHaveBeenCalledTimes(5);
    });

    it('keeps observing on subsequent collections after a failure', () => {
      const source = buildSource(snapshot());
      source.getDatabasePoolMetrics
        .mockImplementationOnce(() => {
          throw new Error('transient');
        })
        .mockReturnValue({ open: 2, busy: 1, idle: 1, pending: 0, max: 10 });
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([source]));
      recorder.onApplicationBootstrap();

      const callback = captureCallback();
      const first: FakeBatchResult = { observe: jest.fn() };
      callback(first);
      const second: FakeBatchResult = { observe: jest.fn() };
      callback(second);

      expect(first.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.open' }), 0);
      expect(second.observe).toHaveBeenCalledWith(expect.objectContaining({ name: 'db.pool.connections.open' }), 2);
    });
  });

  describe('shutdown', () => {
    it('removes the batch callback with the same callback and instruments', () => {
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([buildSource(snapshot())]));
      recorder.onApplicationBootstrap();

      const meter = getMockMeter();
      const [registeredCallback, registeredGauges] = meter.addBatchObservableCallback.mock.calls[0];

      recorder.onApplicationShutdown();

      expect(meter.removeBatchObservableCallback).toHaveBeenCalledWith(registeredCallback, registeredGauges);
    });

    it('is a no-op on shutdown when bootstrap was idle', () => {
      delete process.env[OTEL_METRICS_EXPORTER_ENV];
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([buildSource(snapshot())]));
      recorder.onApplicationBootstrap();

      expect(() => recorder.onApplicationShutdown()).not.toThrow();
      expect(getMockMeter().removeBatchObservableCallback).not.toHaveBeenCalled();
    });

    it('is safe to call shutdown twice', () => {
      const recorder = new DbPoolMetricsRecorder(buildDiscoveryService([buildSource(snapshot())]));
      recorder.onApplicationBootstrap();

      recorder.onApplicationShutdown();
      recorder.onApplicationShutdown();

      expect(getMockMeter().removeBatchObservableCallback).toHaveBeenCalledTimes(1);
    });
  });
});

function snapshot(): DatabasePoolMetricsSnapshot {
  return { open: 1, busy: 1, idle: 0, pending: 0, max: 10 };
}
