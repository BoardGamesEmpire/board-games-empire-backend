import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { Global, Module } from '@nestjs/common';
import { PluginConfigEventsService } from './config/plugin-config-events.service';
import { PluginConfigSchemaService } from './config/plugin-config-schema.service';
import { PluginConfigService } from './config/plugin-config.service';
import { PluginConsentCheckClassifier } from './consent/plugin-consent-check-classifier.service';
import { PluginConsentPresentationService } from './consent/plugin-consent-presentation.service';
import { PluginContextFactory } from './context/plugin-context.factory';
import { PluginFeatureStateService } from './features/plugin-feature-state.service';
import { PluginGrantAuthorityService } from './grants/plugin-grant-authority.service';
import { PluginGrantService } from './grants/plugin-grant.service';
import { PluginInstallerService } from './install/plugin-installer.service';
import { PluginStaticAnalysisService } from './install/plugin-static-analysis.service';
import { PluginLifecycleListener } from './lifecycle/plugin-lifecycle.listener';
import { PluginLifecycleService } from './lifecycle/plugin-lifecycle.service';
import { PluginDirectoryResolverService } from './loader/plugin-directory-resolver.service';
import { PluginInstanceRegistry } from './loader/plugin-instance-registry';
import { PluginLoaderService } from './loader/plugin-loader.service';
import { DynamicImportPluginModuleImporter, PLUGIN_MODULE_IMPORTER } from './loader/plugin-module-importer';
import { ConfigurableModuleClass } from './plugin-module.options';
import { PluginUpdateService } from './update/plugin-update.service';

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
 *
 * `@Global()`: a single plugin runtime per process, configured ONCE by the
 * host's `forRootAsync` — the StorageModule precedent. The HTTP surface
 * (`@bge/plugins`) mounts beside it and injects the exported services; a
 * static re-import there would instantiate a second, options-less runtime
 * and fail boot on `MODULE_OPTIONS_TOKEN`. Feature modules inject only
 * what `exports` names — global visibility does not widen the boundary.
 */
@Global()
@Module({
  imports: [AuditContextModule, DatabaseModule],
  providers: [
    { provide: PLUGIN_MODULE_IMPORTER, useClass: DynamicImportPluginModuleImporter },
    PluginConsentCheckClassifier,
    PluginConsentPresentationService,
    PluginDirectoryResolverService,
    PluginFeatureStateService,
    PluginInstanceRegistry,
    PluginContextFactory,
    PluginConfigEventsService,
    PluginConfigSchemaService,
    PluginConfigService,
    PluginGrantAuthorityService,
    PluginGrantService,
    PluginInstallerService,
    PluginLifecycleListener,
    PluginLifecycleService,
    PluginLoaderService,
    PluginStaticAnalysisService,
    PluginUpdateService,
  ],
  exports: [
    PluginConsentPresentationService,
    PluginFeatureStateService,
    PluginInstanceRegistry,
    PluginConfigService,
    PluginContextFactory,
    PluginGrantService,
    PluginInstallerService,
    // The one export #320 widened the boundary by: the endpoint-facing
    // lifecycle writer. Its collaborators (schema validation, authority,
    // registry) stay internal.
    PluginLifecycleService,
    PluginUpdateService,
  ],
})
export class PluginModule extends ConfigurableModuleClass {}
