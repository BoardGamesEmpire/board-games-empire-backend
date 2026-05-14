import { DatabaseModule } from '@bge/database';
import { DynamicModule, Module } from '@nestjs/common';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';
import { GatewayConfigEventsModule, GatewayConfigEventsModuleAsyncOptions } from './gateway-config-events.module';
import { GatewayRegistryBootstrapService } from './gateway-registry.bootstrap.service';
import { GatewayRegistryService } from './gateway-registry.service';

/**
 * Full gateway connection management. Apps that need to call gateways
 * (coordinator, gateway-worker) import this. Internally composes the
 * GatewayConfigEventsModule for pub/sub primitives and adds:
 *   - GatewayRegistryService: gRPC client lifecycle + failure tracking
 *   - GatewayCredentialsFactory: auth-type-based ChannelCredentials
 *   - GatewayRegistryBootstrapService: eager-connect at app startup
 *
 * Configured once at the application root via forRootAsync(). Global —
 * feature modules inject GatewayRegistryService without re-importing.
 */
@Module({})
export class GatewayRegistryModule {
  static forRootAsync(options: GatewayConfigEventsModuleAsyncOptions): DynamicModule {
    return {
      module: GatewayRegistryModule,
      global: true,
      imports: [DatabaseModule, GatewayConfigEventsModule.forRootAsync(options)],
      providers: [GatewayCredentialsFactory, GatewayRegistryService, GatewayRegistryBootstrapService],
      exports: [GatewayCredentialsFactory, GatewayRegistryService],
    };
  }
}
