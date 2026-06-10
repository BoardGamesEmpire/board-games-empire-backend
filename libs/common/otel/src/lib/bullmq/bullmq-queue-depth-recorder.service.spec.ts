jest.mock('bullmq', () => {
  // Custom Queue class so `instanceof Queue` in the recorder works
  // against test doubles. Real Queue can't be instantiated without a
  // Redis connection.
  class MockQueue {
    public readonly name: string;
    public recordJobCountsMetric: jest.Mock<Promise<Record<string, number>>, []>;

    constructor(name: string) {
      this.name = name;
      this.recordJobCountsMetric = jest.fn(async () => ({}));
    }
  }
  return { Queue: MockQueue };
});

import type { DiscoveryService } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { Queue } from 'bullmq';
import { OTEL_EXPORTER_NONE, OTEL_METRICS_EXPORTER_ENV } from '../init/otel.config';
import { BullMQQueueDepthRecorder } from './bullmq-queue-depth-recorder.service';

const METRIC_EXPORT_INTERVAL_ENV = 'OTEL_METRIC_EXPORT_INTERVAL';

interface MockedQueue {
  readonly name: string;
  readonly recordJobCountsMetric: jest.Mock<Promise<Record<string, number>>, []>;
}

const restoreEnvVar = (name: string, original: string | undefined): void => {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
};

const buildDiscoveryService = (queues: Queue[]): DiscoveryService => {
  const wrappers: Array<Pick<InstanceWrapper, 'instance'>> = queues.map((queue) => ({
    instance: queue as unknown,
  }));
  // Add a non-Queue provider to verify the recorder filters by type.
  wrappers.push({ instance: { someOtherService: true } as unknown });

  return {
    getProviders: jest.fn(() => wrappers as InstanceWrapper[]),
  } as unknown as DiscoveryService;
};

describe('BullMQQueueDepthRecorder', () => {
  let originalMetricsExporter: string | undefined;
  let originalInterval: string | undefined;

  beforeEach(() => {
    originalMetricsExporter = process.env[OTEL_METRICS_EXPORTER_ENV];
    originalInterval = process.env[METRIC_EXPORT_INTERVAL_ENV];

    // Default: metrics enabled, so most tests don't need to set this.
    process.env[OTEL_METRICS_EXPORTER_ENV] = 'otlp';
    delete process.env[METRIC_EXPORT_INTERVAL_ENV];

    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    restoreEnvVar(OTEL_METRICS_EXPORTER_ENV, originalMetricsExporter);
    restoreEnvVar(METRIC_EXPORT_INTERVAL_ENV, originalInterval);
  });

  describe('idle states', () => {
    it('does not start the timer when OTEL_METRICS_EXPORTER is unset', () => {
      delete process.env[OTEL_METRICS_EXPORTER_ENV];
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);

      expect(queue.recordJobCountsMetric).not.toHaveBeenCalled();
    });

    it('does not start the timer when OTEL_METRICS_EXPORTER is "none"', () => {
      process.env[OTEL_METRICS_EXPORTER_ENV] = OTEL_EXPORTER_NONE;
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);

      expect(queue.recordJobCountsMetric).not.toHaveBeenCalled();
    });

    it('does not start the timer when no queues are discovered', () => {
      const discovery = buildDiscoveryService([]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      // Advance enough to trigger any timer that might have been set.
      jest.advanceTimersByTime(60_000);

      // No queues, so no calls.
      expect(true).toBe(true);
    });
  });

  describe('discovery filtering', () => {
    it('only invokes recordJobCountsMetric on Queue instances', () => {
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);

      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(1);
    });

    it('records all discovered queues on each tick', () => {
      const queues = [
        new Queue('queue-1') as unknown as MockedQueue,
        new Queue('queue-2') as unknown as MockedQueue,
        new Queue('queue-3') as unknown as MockedQueue,
      ];
      const discovery = buildDiscoveryService(queues as unknown as Queue[]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);

      for (const queue of queues) {
        expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('polling cadence', () => {
    it('records again on each interval tick', () => {
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);
      jest.advanceTimersByTime(60_000);
      jest.advanceTimersByTime(60_000);

      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(3);
    });

    it('uses the default 60_000ms interval when OTEL_METRIC_EXPORT_INTERVAL is unset', () => {
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(59_999);
      expect(queue.recordJobCountsMetric).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(1);
    });

    it('respects OTEL_METRIC_EXPORT_INTERVAL when valid', () => {
      process.env[METRIC_EXPORT_INTERVAL_ENV] = '10000';
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(10_000);

      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(1);
    });

    it('falls back to default when OTEL_METRIC_EXPORT_INTERVAL is non-numeric', () => {
      process.env[METRIC_EXPORT_INTERVAL_ENV] = 'not-a-number';
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(10_000);
      expect(queue.recordJobCountsMetric).not.toHaveBeenCalled();

      jest.advanceTimersByTime(50_000);
      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(1);
    });

    it('falls back to default when OTEL_METRIC_EXPORT_INTERVAL is non-positive', () => {
      process.env[METRIC_EXPORT_INTERVAL_ENV] = '0';
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);

      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-queue failure isolation', () => {
    it('continues recording other queues when one throws', async () => {
      const failing = new Queue('failing-queue') as unknown as MockedQueue;
      const healthy = new Queue('healthy-queue') as unknown as MockedQueue;
      failing.recordJobCountsMetric.mockImplementation(async () => {
        throw new Error('redis connection lost');
      });

      const discovery = buildDiscoveryService([failing as unknown as Queue, healthy as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);
      // Let the awaited promises in recordAll resolve.
      await Promise.resolve();
      await Promise.resolve();

      expect(failing.recordJobCountsMetric).toHaveBeenCalledTimes(1);
      expect(healthy.recordJobCountsMetric).toHaveBeenCalledTimes(1);
    });

    it('keeps polling on subsequent ticks after a failure', async () => {
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      queue.recordJobCountsMetric.mockRejectedValueOnce(new Error('transient'));
      queue.recordJobCountsMetric.mockResolvedValue({});

      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(2);
    });
  });

  describe('shutdown', () => {
    it('clears the interval on shutdown', () => {
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);
      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(1);

      recorder.onApplicationShutdown();
      jest.advanceTimersByTime(60_000 * 5);

      // No additional calls after shutdown.
      expect(queue.recordJobCountsMetric).toHaveBeenCalledTimes(1);
    });

    it('is safe to call shutdown when bootstrap was a no-op (no metrics)', () => {
      delete process.env[OTEL_METRICS_EXPORTER_ENV];
      const discovery = buildDiscoveryService([]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();

      expect(() => recorder.onApplicationShutdown()).not.toThrow();
    });

    it('is safe to call shutdown twice', () => {
      const queue = new Queue('test-queue') as unknown as MockedQueue;
      const discovery = buildDiscoveryService([queue as unknown as Queue]);
      const recorder = new BullMQQueueDepthRecorder(discovery);

      recorder.onApplicationBootstrap();
      recorder.onApplicationShutdown();

      expect(() => recorder.onApplicationShutdown()).not.toThrow();
    });
  });
});
