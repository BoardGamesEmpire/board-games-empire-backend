import { Global, Module } from '@nestjs/common';
import { GatewayConfigEventsService } from './gateway-config-events.service';

/**
 * Lightweight module exposing the gateway config event publisher/subscriber.
 * Apps that only need to publish events (e.g., the API on admin mutations)
 * import this directly. Apps that also need full gateway connection
 * management import `GatewayRegistryModule`, which composes this module
 * internally.
 *
 * Global by design — the events service should be available app-wide
 * without explicit re-import in feature modules.
 *
 * Depends on `CACHE_REDIS_CLIENT` being available in the DI container —
 * typically provided by `RedisModule.forRootAsync({ cache: ... })` from
 * `@bge/redis`. The cache database hosts the gateway config event pub/sub
 * channel; both share invalidation semantics (a `FLUSHDB` of the cache
 * implicitly cancels pending invalidation messages, which is the desired
 * behavior).
 */
@Global()
@Module({
  providers: [GatewayConfigEventsService],
  exports: [GatewayConfigEventsService],
})
export class GatewayConfigEventsModule {}
