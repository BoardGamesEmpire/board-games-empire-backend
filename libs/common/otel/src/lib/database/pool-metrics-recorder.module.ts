import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DbPoolMetricsRecorder } from './pool-metrics-recorder.service';

/**
 * Registers the {@link DbPoolMetricsRecorder}. Import once at the
 * application root alongside `DatabaseModule` so the recorder can
 * discover the `DatabaseService` (and any other
 * {@link DatabasePoolMetricsSource}) registered downstream:
 *
 * ```ts
 * @Module({
 *   imports: [DatabaseModule, DbPoolMetricsRecorderModule],
 * })
 * export class AppModule {}
 * ```
 *
 * Idles when metrics export is not enabled and when no pool-metrics
 * source is discovered (see {@link DbPoolMetricsRecorder}), so importing
 * it in an app that happens to have no database client is harmless.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [DbPoolMetricsRecorder],
})
export class DbPoolMetricsRecorderModule {}
