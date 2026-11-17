import { AuditContextModule } from '@bge/actor-context';
import { PLUGIN_DRIVER_SOURCE } from '@bge/gateway-registry';
import { Global, Module } from '@nestjs/common';
import { PluginDataGatewaySource } from './plugin-data-gateway.source';
import { PluginGatewayController } from './plugin-gateway.controller';

/**
 * Makes the process that mounts it the one that hosts the server's
 * data-gateway plugins (#1083): the coordinator. It gives the gateway
 * registry its plugin driver source, {@link PluginDataGatewaySource}, which
 * builds a plugin DataGateway's driver from the plugin this process loaded,
 * and it serves the gateway gRPC protocol for those drivers
 * ({@link PluginGatewayController}), which is how the gateway worker reaches
 * them.
 *
 * `@Global()`, and the token is its one export: the gateway registry takes
 * the source by an optional injection, from a module that can't import this
 * one.
 *
 * What a process that mounts it must also mount, relied on as globals and
 * not imported here:
 * - `PluginModule.forRoot(...)` or `forRootAsync(...)` of `@bge/plugin`,
 *   whose `PluginInstanceRegistry` holds the plugins this process loaded.
 *   Its options name `PluginCategory.DataGateway` in `loadCategories`, and
 *   carry `dataGatewayProductCheck` for that category in `productChecks`. A
 *   static import of `PluginModule` here would build a second runtime with
 *   no options.
 * - `GatewayRegistryModule` of `@bge/gateway-registry`, for the
 *   `GatewayRegistryService` the controller routes each call through.
 * - `ClsModule.forRoot({ global: true, ... })`, which the plugin actor
 *   scope of `AuditContextModule` runs on.
 * - A gRPC microservice that serves the `bge.gateway.v1` package, or the
 *   controller's handlers are never reached.
 */
@Global()
@Module({
  imports: [AuditContextModule],
  controllers: [PluginGatewayController],
  providers: [PluginDataGatewaySource, { provide: PLUGIN_DRIVER_SOURCE, useExisting: PluginDataGatewaySource }],
  exports: [PLUGIN_DRIVER_SOURCE],
})
export class GatewayPluginHostModule {}
