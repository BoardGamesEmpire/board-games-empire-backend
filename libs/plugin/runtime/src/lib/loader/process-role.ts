import { PluginCategory, type Plugin } from '@bge/database';

/**
 * The process roles that load plugins. The names are the ones the launcher
 * gives those processes, so they are not translated.
 */
export const PLUGIN_PROCESS_ROLES = ['api', 'coordinator'] as const;
export type PluginProcessRole = (typeof PLUGIN_PROCESS_ROLES)[number];

/**
 * The process role that loads plugins of a category: the coordinator loads
 * data-gateway plugins, the api every other category (#1096). A category added
 * later is the api's unless it is data-gateway, so the answer is never missing.
 *
 * Until the coordinator loads plugins in its own right, it loads none, yet a
 * data-gateway plugin still names it: it is the process that has to load it.
 * Working this out from the plugin load records instead is #332's; the body
 * can move to the records without changing what callers receive.
 *
 * The answer is from the category alone, so an update that moves a plugin
 * into or out of data-gateway names only the process role of the category it
 * moves to. The process of the other role keeps running the old code until it
 * restarts too, which only the load records can tell (#332).
 */
export function processRoleLoading(category: PluginCategory): PluginProcessRole {
  return category === PluginCategory.DataGateway ? 'coordinator' : 'api';
}

/**
 * The process roles to restart for a plugin so the server runs what it has
 * recorded: none unless a restart is required (#1096). A fresh array each
 * call, so no caller can change another's answer.
 */
export function restartProcessRoles(
  plugin: Pick<Plugin, 'category' | 'restartRequired'>,
): readonly PluginProcessRole[] {
  return plugin.restartRequired ? [processRoleLoading(plugin.category)] : [];
}
