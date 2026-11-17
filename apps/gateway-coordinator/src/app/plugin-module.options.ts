import { categoriesLoadedBy, PluginCategory } from '@bge/database';
import { dataGatewayProductCheck } from '@bge/gateway-plugin-host';
import { FALLBACK_LOCALE } from '@bge/i18n';
import type { PluginModuleOptions } from '@bge/plugin';
import { BGE_VERSION } from '@bge/version';
import type { ConfigService } from '@nestjs/config';

/** The coordinator's process role, which labels its plugin load records and decides which categories it loads (#1083). */
const PROCESS_ROLE = 'coordinator';

/**
 * The coordinator's options for the plugin runtime (#1083). It loads the
 * data-gateway plugins and nothing else: a plugin DataGateway runs as one
 * copy, here, and the gateway worker reaches it over the gateway gRPC
 * protocol. The api loads every other category.
 *
 * `processRole` is the one `roleLoading` answers for a data-gateway plugin:
 * the gateway worker asks this process role's plugin load records whether a
 * plugin is loaded before it routes a call to it. The categories it loads
 * are the ones `roleLoading` gives it.
 *
 * The other values come from where the api's do: the plugins root from the
 * one config both load (`@bge/plugin`'s `pluginsConfig`), the version from
 * the build, and the locale manifests fall back to from the shipped
 * catalogs.
 */
export function coordinatorPluginModuleOptions(config: ConfigService): PluginModuleOptions {
  return {
    pluginsRoot: config.getOrThrow<string>('plugins.pluginsRoot'),
    processRole: PROCESS_ROLE,
    loadCategories: categoriesLoadedBy(PROCESS_ROLE),
    productChecks: { [PluginCategory.DataGateway]: dataGatewayProductCheck },
    // A gateway worker dials this process once a record says ready, and the
    // gRPC server listens only after the plugins load: `main.ts` says when.
    readyOnceServing: true,
    bgeVersion: BGE_VERSION,
    defaultLocale: FALLBACK_LOCALE,
  };
}
