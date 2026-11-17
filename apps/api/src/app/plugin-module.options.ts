import { PluginCategory } from '@bge/database';
import { FALLBACK_LOCALE } from '@bge/i18n';
import type { PluginModuleOptions } from '@bge/plugin';
import { BGE_VERSION } from '@bge/version';
import type { ConfigService } from '@nestjs/config';

/**
 * The plugin categories the api loads (#1083): every one but the data-gateway
 * plugins, which the coordinator hosts. Read from the enum, so a category
 * added later loads here unless it is given to another process role.
 */
const API_PLUGIN_CATEGORIES = Object.values(PluginCategory).filter(
  (category) => category !== PluginCategory.DataGateway,
);

/** The api's options for the plugin runtime. */
export function apiPluginModuleOptions(config: ConfigService): PluginModuleOptions {
  return {
    pluginsRoot: config.getOrThrow<string>('plugins.pluginsRoot'),
    // Labels this process's plugin load records (#1094). The coordinator
    // writes them too, under its own process role, for the data-gateway
    // plugins it loads (#1083).
    processRole: 'api',
    loadCategories: API_PLUGIN_CATEGORIES,
    // Build-time codegen constant (`@bge/version`) — the version is a
    // property of the artifact, not of the environment it runs in.
    bgeVersion: BGE_VERSION,
    // Manifest localization bottoms out where the request-time resolver
    // chain does — the shipped-catalog fallback, not a separate knob.
    defaultLocale: FALLBACK_LOCALE,
  };
}
