import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { PLUGIN_DRIVER_SOURCE } from '@bge/gateway-registry';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration } from './configuration';
import { PluginGatewayRelaySource } from './plugin-gateway-relay.source';

/**
 * Gives the gateway registry of a process that loads no plugin its plugin
 * driver source: {@link PluginGatewayRelaySource}, which reaches each plugin
 * DataGateway through the coordinator (#1083). The gateway worker mounts it.
 * The coordinator must not, since it provides a source of its own under the
 * same token.
 *
 * Global, because the gateway registry's module asks for the source without
 * importing the module that provides it.
 *
 * A process that mounts this must also mount:
 * - `GatewayRegistryModule`, whose global exports hold the
 *   `RemoteGatewayDriverFactory` the source dials with;
 * - `ClsModule.forRoot({ global: true })`, where the source reads the actor
 *   in scope and opens the system actor's.
 *
 * Its root config schema needs `coordinatorClientConfigValidationSchema`,
 * since `forFeature` validates nothing.
 *
 * `GatewayCoordinatorClientModule` is left out on purpose. That is the api's
 * client of the coordinator's own protocol, and it pings the coordinator on a
 * timer. The source dials the same address, over the gateway gRPC protocol.
 */
@Global()
@Module({
  imports: [AuditContextModule, DatabaseModule, ConfigModule.forFeature(configuration.coordinator)],
  providers: [PluginGatewayRelaySource, { provide: PLUGIN_DRIVER_SOURCE, useExisting: PluginGatewayRelaySource }],
  exports: [PLUGIN_DRIVER_SOURCE],
})
export class PluginGatewayRelayModule {}
