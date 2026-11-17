import { categoriesLoadedBy } from '@bge/database';
import { FALLBACK_LOCALE } from '@bge/i18n';
import type { PluginModuleOptions } from '@bge/plugin';
import { BGE_VERSION } from '@bge/version';
import type { ConfigService } from '@nestjs/config';

/** The api's process role, which labels its plugin load records and decides which categories it loads (#1083). */
const PROCESS_ROLE = 'api';

/** The api's options for the plugin runtime. */
export function apiPluginModuleOptions(config: ConfigService): PluginModuleOptions {
  return {
    pluginsRoot: config.getOrThrow<string>('plugins.pluginsRoot'),
    // Labels this process's plugin load records (#1094). The coordinator
    // writes them too, under its own process role, for the data-gateway
    // plugins it loads (#1083).
    processRole: PROCESS_ROLE,
    // Every category but the data-gateway plugins, which the coordinator
    // hosts, as `roleLoading` decides: a category added later loads here
    // unless it is given to another process role.
    loadCategories: categoriesLoadedBy(PROCESS_ROLE),
    // Build-time codegen constant (`@bge/version`) — the version is a
    // property of the artifact, not of the environment it runs in.
    bgeVersion: BGE_VERSION,
    // Manifest localization bottoms out where the request-time resolver
    // chain does — the shipped-catalog fallback, not a separate knob.
    defaultLocale: FALLBACK_LOCALE,
  };
}
