import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { BatchObservableCallback, BatchObservableResult, ObservableGauge } from '@opentelemetry/api';
import { metrics } from '@opentelemetry/api';
import { metricsExportEnabled } from '../init/metrics-enabled';
import type { DatabasePoolMetricsSnapshot, DatabasePoolMetricsSource } from './pool-metrics-source';
import { isDatabasePoolMetricsSource } from './pool-metrics-source';

/**
 * Instrumentation scope name for the emitted pool gauges.
 */
const METER_NAME = 'bge-database-pool';
const CONNECTION_UNIT = '{connection}';
const REQUEST_UNIT = '{request}';

/**
 * Bridges `pg` connection-pool stats to OpenTelemetry as a set of
 * {@link ObservableGauge} instruments. Pool exhaustion is the most
 * common Prisma-side production symptom, and trace data alone won't tell
 * you that queries are queueing because the pool is saturated —
 * `db.pool.connections.pending` is the signal that does.
 *
 * Why observable (not a timer): unlike {@link BullMQQueueDepthRecorder},
 * which polls on a `setInterval` because `bullmq-otel` owns a synchronous
 * gauge it must refresh externally, we own these instruments and pool
 * reads are cheap synchronous getters. An `ObservableGauge` with a single
 * batch-observe callback is the natural fit: registered once at bootstrap,
 * OTel pulls it at export time. No timer, no `.unref()`, no interval to
 * clear.
 *
 * Discovery: uses `@nestjs/core`'s `DiscoveryService` to find every
 * provider satisfying {@link DatabasePoolMetricsSource}, so `@bge/otel`
 * never imports `@bge/database`. In practice every BGE app has exactly
 * one such provider (`DatabaseService`); the recorder sums across any it
 * finds so two sources can't clobber each other's observation for the
 * same (empty) attribute set within a collection.
 *
 * Activation: idles unless {@link metricsExportEnabled} returns true —
 * the same gate consulted by `resolveMetricReader` and the BullMQ
 * recorder, so the pieces always agree on whether metrics export is live.
 *
 * Failure isolation: per-source try/catch inside the callback, so one
 * source throwing on read does not abort observation of the others or
 * subsequent collections.
 */
@Injectable()
export class DbPoolMetricsRecorder implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DbPoolMetricsRecorder.name);
  private sources: DatabasePoolMetricsSource[] = [];
  private gauges: ObservableGauge[] | undefined;
  private batchCallback: BatchObservableCallback | undefined;

  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    if (!metricsExportEnabled()) {
      return this.logger.debug('Metrics export not enabled; database pool metrics recorder is idle');
    }

    this.sources = this.discoverSources();
    if (this.sources.length === 0) {
      this.logger.debug('No database pool metrics sources discovered; recorder is idle');
      return;
    }

    const meter = metrics.getMeter(METER_NAME);

    const open = meter.createObservableGauge('db.pool.connections.open', {
      description: 'Total connections currently in the pool (busy + idle).',
      unit: CONNECTION_UNIT,
    });
    const busy = meter.createObservableGauge('db.pool.connections.busy', {
      description: 'Connections currently checked out and in use.',
      unit: CONNECTION_UNIT,
    });
    const idle = meter.createObservableGauge('db.pool.connections.idle', {
      description: 'Connections currently open but unused.',
      unit: CONNECTION_UNIT,
    });
    const pending = meter.createObservableGauge('db.pool.connections.pending', {
      description: 'Requests queued waiting for a free connection; pool-pressure signal.',
      unit: REQUEST_UNIT,
    });
    const max = meter.createObservableGauge('db.pool.connections.max', {
      description: 'Configured maximum pool size; the exhaustion denominator.',
      unit: CONNECTION_UNIT,
    });

    this.gauges = [open, busy, idle, pending, max];
    this.batchCallback = (result: BatchObservableResult): void => {
      const snapshot = this.collect();
      result.observe(open, snapshot.open);
      result.observe(busy, snapshot.busy);
      result.observe(idle, snapshot.idle);
      result.observe(pending, snapshot.pending);
      result.observe(max, snapshot.max);
    };

    meter.addBatchObservableCallback(this.batchCallback, this.gauges);
    this.logger.log(`Observing database pool metrics for ${this.sources.length} source(s)`);
  }

  onApplicationShutdown(): void {
    if (this.batchCallback !== undefined && this.gauges !== undefined) {
      metrics.getMeter(METER_NAME).removeBatchObservableCallback(this.batchCallback, this.gauges);
      this.batchCallback = undefined;
      this.gauges = undefined;
    }
  }

  /**
   * Sums each discovered source's snapshot into a single process-level
   * view. With the usual one source this is a passthrough; aggregating
   * keeps multiple pools (e.g. a future read replica) coherent rather
   * than letting them overwrite one another. A source that throws is
   * logged and skipped so it contributes nothing rather than failing the
   * whole collection.
   */
  private collect(): DatabasePoolMetricsSnapshot {
    const total = { open: 0, busy: 0, idle: 0, pending: 0, max: 0 };

    for (const source of this.sources) {
      try {
        const snapshot = source.getDatabasePoolMetrics();
        total.open += snapshot.open;
        total.busy += snapshot.busy;
        total.idle += snapshot.idle;
        total.pending += snapshot.pending;
        total.max += snapshot.max;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to read database pool metrics from a source: ${message}`);
      }
    }

    return total;
  }

  private discoverSources(): DatabasePoolMetricsSource[] {
    return this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter(isDatabasePoolMetricsSource);
  }
}
