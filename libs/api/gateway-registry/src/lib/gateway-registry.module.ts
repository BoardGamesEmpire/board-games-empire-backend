import { DatabaseModule } from '@bge/database';
import { Global, Module } from '@nestjs/common';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';
import { GatewayConfigEventsModule } from './gateway-config-events.module';
import { GatewayRegistryBootstrapService } from './gateway-registry.bootstrap.service';
import { GatewayRegistryService } from './gateway-registry.service';

/**
 * Full gateway connection management. Apps that need to call gateways
 * (coordinator, gateway-worker) import this. Internally composes the
 * `GatewayConfigEventsModule` for pub/sub primitives and adds:
 *   - `GatewayRegistryService`: gRPC client lifecycle + failure tracking
 *   - `GatewayCredentialsFactory`: auth-type-based ChannelCredentials
 *   - `GatewayRegistryBootstrapService`: eager-connect at app startup
 *
 * Global — feature modules inject `GatewayRegistryService` without
 * re-importing.
 *
 * Depends on `CACHE_REDIS_CLIENT` being available in the DI container —
 * typically provided by `RedisModule.forRootAsync({ cache: ... })` from
 * `@bge/redis`.
 */
@Global()
@Module({
  imports: [DatabaseModule, GatewayConfigEventsModule],
  providers: [GatewayCredentialsFactory, GatewayRegistryService, GatewayRegistryBootstrapService],
  exports: [GatewayCredentialsFactory, GatewayRegistryService],
})
export class GatewayRegistryModule {}
