import { DatabaseModule } from '@bge/database';
import { CACHE_REDIS_CLIENT, createCacheStore, type Redis } from '@bge/redis';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { GatewayGameSearchService } from './gateway-game-search.service';

/**
 * Hosts fan-out game search over the gateway driver registry (#193).
 * Imported by the coordinator today; the API-side GameSearchModule
 * (@bge/game-search) adopts it in Phase 1 in place of the coordinator
 * gRPC client.
 *
 * Owns its cache-manager registration (search-result caching is this
 * module's concern). `GatewayRegistryService` arrives via the @Global
 * GatewayRegistryModule; `CACHE_REDIS_CLIENT` must be provided by the
 * hosting app's RedisModule, as everywhere else.
 */
@Module({
  imports: [
    DatabaseModule,
    CacheModule.registerAsync({
      inject: [CACHE_REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        stores: [createCacheStore(redis, 'search:cache')],
        // cache-manager v7 interprets ttl in MILLISECONDS, so a `300` meant as
        // seconds is a 300ms default. Every consumer here passes an explicit
        // ms TTL, but the default should not be a trap for the next caller.
        ttl: 5 * 60 * 1000,
      }),
    }),
  ],
  providers: [GatewayGameSearchService],
  exports: [GatewayGameSearchService],
})
export class GatewayGameSearchModule {}
