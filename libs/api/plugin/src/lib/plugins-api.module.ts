import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { PluginArtifactsModule } from '@bge/plugin-artifacts';
import { Module } from '@nestjs/common';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';
import { HouseholdPluginsController } from './household-plugins.controller';
import { PluginArtifactsController } from './plugin-artifacts.controller';
import { PluginsController } from './plugins.controller';
import { PluginArtifactUploadInterceptor } from './upload/plugin-artifact-upload.interceptor';
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
    // Supplies DatabaseService to the controller-scoped HouseholdLivenessGuard
    // (#553), which probes the route's household. Nest resolves a
    // class-referenced guard in the controller's host module, and the database
    // module is not global, so without this the app fails at boot.
    DatabaseModule,
    // The receiver and the installer behind the install ingress's routes (#1094).
    PluginArtifactsModule,
    // No import for the controller's other dependencies: PermissionsModule
    // (PoliciesGuard, AbilityService) and the runtime `@bge/plugin`
    // (PluginLifecycleService) are both global modules, the latter
    // configured once by the host's forRootAsync.
  ],
  // `PluginsController` must stay first. `artifacts/:sha256` would otherwise
  // capture `GET /plugins/artifacts/consent` and `/features`, which belong to
  // a plugin slugged `artifacts` (a valid slug, deliberately not reserved). The
  // reverse costs nothing, since no checksum is either word, and no
  // `PluginsController` route can capture `POST /plugins/artifacts`,
  // `POST /plugins/install` or a checksum read. A module spec pins the order.
  controllers: [PluginsController, PluginArtifactsController, HouseholdPluginsController, UserPluginsController],
  providers: [PluginExceptionFilter, PluginArtifactUploadInterceptor],
  exports: [AuditContextModule, PluginExceptionFilter],
})
export class PluginsApiModule {}
