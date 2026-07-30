import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { PluginConfigEventsService } from './config/plugin-config-events.service';
import { PluginConfigService } from './config/plugin-config.service';
import { PluginContextFactory } from './context/plugin-context.factory';
import { PluginGrantAuthorityService } from './grants/plugin-grant-authority.service';
import { PluginGrantService } from './grants/plugin-grant.service';
import { PluginInstallerService } from './install/plugin-installer.service';
import { PluginStaticAnalysisService } from './install/plugin-static-analysis.service';
import { PluginLifecycleListener } from './lifecycle/plugin-lifecycle.listener';
import { PluginDirectoryResolverService } from './loader/plugin-directory-resolver.service';
import { PluginInstanceRegistry } from './loader/plugin-instance-registry';
import { PluginLoaderService } from './loader/plugin-loader.service';
import { DynamicImportPluginModuleImporter, PLUGIN_MODULE_IMPORTER } from './loader/plugin-module-importer';
import { ConfigurableModuleClass } from './plugin-module.options';

/**
 * The plugin runtime (#59 Phase B): boot loader, per-plugin contexts,
 * config hot-reload, and the lifecycle provenance listener. The API app
 * imports this with a thin edge — `PluginModule.forRoot({...})` (or
 * `forRootAsync`) supplying the plugin roots and version identity.
 *
 * Host prerequisites (documented rather than imported, matching how the
 * peer subsystems wire them):
 * - `ClsModule.forRoot({ global: true, ... })` — CLS lifecycle is app-owned
 *   (the `AuditContextModule` contract).
 * - `EventEmitterModule.forRoot(...)` — the lifecycle listener registers
 *   via `onAny` and is emitter-config agnostic.
 * - `@bge/redis` providing `CACHE_REDIS_CLIENT` — config hot-reload rides
 *   the cache connection tier, same placement as the SafeHttpPolicy and
 *   gateway-config channels.
 * - `ScheduleModule.forRoot()` where the config-refresh interval backstop
 *   should fire (api/worker); elsewhere the decorator is inert.
 */
@Module({
  imports: [AuditContextModule, DatabaseModule],
  providers: [
    { provide: PLUGIN_MODULE_IMPORTER, useClass: DynamicImportPluginModuleImporter },
    PluginDirectoryResolverService,
    PluginInstanceRegistry,
    PluginContextFactory,
    PluginConfigEventsService,
    PluginConfigService,
    PluginGrantAuthorityService,
    PluginGrantService,
    PluginInstallerService,
    PluginLifecycleListener,
    PluginLoaderService,
    PluginStaticAnalysisService,
  ],
  exports: [
    PluginInstanceRegistry,
    PluginConfigService,
    PluginContextFactory,
    PluginGrantService,
    PluginInstallerService,
  ],
})
export class PluginModule extends ConfigurableModuleClass {}
