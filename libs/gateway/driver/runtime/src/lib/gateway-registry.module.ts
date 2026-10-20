import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { LanguageLinkModule } from '@bge/language';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { Global, Module } from '@nestjs/common';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';
import { RemoteGatewayDriverFactory } from './drivers/remote-gateway-driver.factory';
import { GatewayConfigEventsModule } from './gateway-config-events.module';
import { GatewayInterviewScheduler } from './gateway-interview.scheduler';
import { GatewayInterviewService } from './gateway-interview.service';
import { GatewayRegistryBootstrapService } from './gateway-registry.bootstrap.service';
import { GatewayRegistryService } from './gateway-registry.service';
import { GatewayNotificationListener } from './listeners/gateway-notification.listener';

/**
 * Full gateway driver management (#193). Apps that need to call gateways
 * (coordinator, gateway-worker) import this. Internally composes the
 * `GatewayConfigEventsModule` for pub/sub primitives and adds:
 *   - `GatewayRegistryService`: driver routing + failure tracking
 *   - `GatewayInterviewService`: the interview, whose answers routing reads
 *   - `GatewayInterviewScheduler`: the interview's hourly backstop
 *   - `RemoteGatewayDriverFactory`: ping-verified gRPC transport adapter
 *   - `GatewayCredentialsFactory`: auth-type-based ChannelCredentials
 *   - `GatewayRegistryBootstrapService`: eager-connect at app startup
 *   - `GatewayNotificationListener`: tells the server admins of an
 *     auto-disable and of lost capabilities (#763)
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
  // AuditContextModule supplies SystemActorScope for the auto-disable path
  // (#57 emit-site migration) and the interview's capability changes.
  // NotificationsServiceModule writes the server admins' notifications of
  // both (#763).
  imports: [
    AuditContextModule,
    DatabaseModule,
    GatewayConfigEventsModule,
    LanguageLinkModule,
    NotificationsServiceModule,
  ],
  providers: [
    GatewayCredentialsFactory,
    GatewayInterviewScheduler,
    GatewayInterviewService,
    GatewayNotificationListener,
    GatewayRegistryBootstrapService,
    GatewayRegistryService,
    RemoteGatewayDriverFactory,
  ],
  exports: [GatewayCredentialsFactory, GatewayRegistryService, RemoteGatewayDriverFactory],
})
export class GatewayRegistryModule {}
