import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Queue } from 'bullmq';
import { metricsExportEnabled } from '../init/metrics-enabled';

const DEFAULT_INTERVAL_MS = 60_000;
const METRIC_EXPORT_INTERVAL_ENV = 'OTEL_METRIC_EXPORT_INTERVAL';

/**
 * Polls every BullMQ {@link Queue} registered in the NestJS DI container
 * and invokes `queue.recordJobCountsMetric()` on each on a fixed timer.
 *
 * Why this exists: bullmq-otel emits the `bullmq.queue.jobs` gauge, but
 * a regular Gauge (not an `ObservableGauge`) — values are recorded only
 * when something calls the recording method. Without periodic invocation
 * the gauge would stay stale at whatever it was last set to (typically
 * the value at a Queue's first call site, if any). This service drives
 * the cadence externally so the gauge stays fresh by the time the OTel
 * SDK exports it.
 *
 * Discovery: uses `@nestjs/core`'s `DiscoveryService` to find every
 * provider that is an instance of `Queue`. This catches anything
 * registered via `BullModule.registerQueue(...)` regardless of injection
 * token shape, so adding a new queue requires no changes here.
 *
 * Activation: idles unless {@link metricsExportEnabled} returns true —
 * the bullmq-otel telemetry instance is also idle in that case, so
 * polling Redis just to call into a no-op meter would be wasteful. The
 * same gate is consulted by `resolveMetricReader` and
 * `createBullMQTelemetry`, so the three pieces always agree on whether
 * metrics export is active.
 *
 * Failure isolation: per-queue try/catch around `recordJobCountsMetric`,
 * so one broken Redis connection does not stop other queues from being
 * sampled.
 */
@Injectable()
export class BullMQQueueDepthRecorder implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BullMQQueueDepthRecorder.name);
  private intervalHandle: NodeJS.Timeout | undefined;
  private queues: Queue[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    if (!metricsExportEnabled()) {
      return this.logger.debug('Metrics export not enabled; queue depth recorder is idle');
    }

    this.queues = this.discoverQueues();
    if (this.queues.length === 0) {
      this.logger.debug('No BullMQ queues discovered; queue depth recorder is idle');
      return;
    }

    const intervalMs = readIntervalMs();
    this.intervalHandle = setInterval(() => {
      void this.recordAll();
    }, intervalMs);
    // Don't keep the Node process alive solely for the recorder; signal
    // handlers must be free to exit cleanly during shutdown.
    this.intervalHandle.unref();

    this.logger.log(`Recording queue depth for ${this.queues.length} queue(s) every ${intervalMs}ms`);
  }

  onApplicationShutdown(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  private async recordAll(): Promise<void> {
    await Promise.all(
      this.queues.map((queue) =>
        queue.recordJobCountsMetric().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to record queue depth for ${queue.name}: ${message}`);
        }),
      ),
    );
  }

  private discoverQueues(): Queue[] {
    return this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter((instance): instance is Queue => instance instanceof Queue);
  }
}

function readIntervalMs(): number {
  const raw = process.env[METRIC_EXPORT_INTERVAL_ENV];
  if (raw === undefined || raw === '') {
    return DEFAULT_INTERVAL_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}
