import { DatabaseModule } from '@bge/database';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import healthConfig from './configuration/health.config';
import { HealthController } from './health.controller';
import { CacheRedisHealthIndicator } from './indicators/cache-redis.health-indicator';
import { PrismaHealthIndicator } from './indicators/prisma.health-indicator';
import { QueueRedisHealthIndicator } from './indicators/queue-redis.health-indicator';
import { StorageHealthIndicator } from './indicators/storage.health-indicator';

/**
 * HealthModule wires the three internal-dependency indicators (Prisma + cache
 * Redis + queue Redis) and HTTP ping support into a single controller.
 *
 * The Redis indicators are `@Optional()` injection — processes that don't
 * configure the corresponding connection via `@bge/redis` pass the check with
 * a "not configured" message rather than failing the readiness probe.
 *
 * `DatabaseModule` is imported (not optional) because every BGE process that
 * loads HealthModule also loads DatabaseModule — auth, CASL, and every
 * domain depend on Postgres. A missing `DatabaseService` would be a wiring
 * bug, and failing loudly via DI is the right response.
 *
 * Both Redis indicators and the Prisma indicator are exported so consumers
 * outside this module (e.g. a future readiness aggregator gateway) can
 * compose them into custom health surfaces.
 *
 * No import of `@bge/redis` is needed: `CACHE_REDIS_CLIENT` and
 * `QUEUE_REDIS_CLIENT` are provided by `RedisModule.forRootAsync` which
 * registers itself as a `global: true` module in each app's bootstrap.
 */
@Module({
  controllers: [HealthController],
  imports: [ConfigModule.forFeature(healthConfig), DatabaseModule, HttpModule, TerminusModule],
  providers: [CacheRedisHealthIndicator, PrismaHealthIndicator, QueueRedisHealthIndicator, StorageHealthIndicator],
  exports: [CacheRedisHealthIndicator, PrismaHealthIndicator, QueueRedisHealthIndicator, StorageHealthIndicator],
})
export class HealthModule {}
