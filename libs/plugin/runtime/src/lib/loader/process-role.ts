import type { Plugin, PluginProcessRole } from '@bge/database';
import { roleLoading } from '@bge/database';

/**
 * The process roles to restart for a plugin so the server runs what it has
 * recorded: none unless a restart is required (#1096). A fresh array each
 * call, so no caller can change another's answer.
 *
 * The answer is from the plugin's category alone, through `roleLoading`, so
 * an update that moves a plugin into or out of data-gateway names only the
 * process role of the category it moves to. The process of the other role
 * keeps running the old code until it restarts too, which only the plugin
 * load records can tell (#332).
 */
export function restartProcessRoles(
  plugin: Pick<Plugin, 'category' | 'restartRequired'>,
): readonly PluginProcessRole[] {
  return plugin.restartRequired ? [roleLoading(plugin.category)] : [];
}
