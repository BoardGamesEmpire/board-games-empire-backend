import { AuditContextModule } from '@bge/actor-context';
import { Module } from '@nestjs/common';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';
import { HouseholdPluginsController } from './household-plugins.controller';
import { PluginsController } from './plugins.controller';
import { UserPluginsController } from './user-plugins.controller';

/**
 * HTTP surface for the plugin system (#59 Phase C4). The runtime lives in
 * `@bge/plugin` (`PluginModule`); this module owns only what belongs at the
 * transport edge — the domain-error → status mapping and, as the C4 slices
 * land (#320–#323), the consent-collection controllers.
 *
 * The exception filter is registered as a provider so its dependency
 * resolution is EAGER: dropping the `AuditContextModule` import crashes boot
 * (guarded by the module spec) instead of failing on the first error response
 * — the regression class PR #184 fixed in media. Controllers attach it with
 * `@UseFilters(PluginExceptionFilter)`; a controller living in ANY OTHER
 * module must import this module. Nest registers a class-referenced enhancer
 * as an injectable of the CONTROLLER'S host module and resolves its
 * dependencies there, so exporting the filter alone would not help — the
 * host module also needs AuditContextService visible, which is why
 * AuditContextModule is RE-EXPORTED alongside the filter (guarded by the
 * foreign-host spec).
 */
@Module({
  imports: [
    // Supplies AuditContextService to the controller-scoped PluginExceptionFilter,
    // which reads the request locale to translate its copy. No provider in this
    // module injects it directly, so the need is easy to miss.
    AuditContextModule,
    // No import for the controller's other dependencies: PermissionsModule
    // (PoliciesGuard, AbilityService) and the runtime `@bge/plugin`
    // (PluginLifecycleService) are both global modules, the latter
    // configured once by the host's forRootAsync.
  ],
  controllers: [PluginsController, HouseholdPluginsController, UserPluginsController],
  providers: [PluginExceptionFilter],
  exports: [AuditContextModule, PluginExceptionFilter],
})
export class PluginsApiModule {}
