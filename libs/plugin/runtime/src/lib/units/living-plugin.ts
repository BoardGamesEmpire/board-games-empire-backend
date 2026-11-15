import type { DatabaseService, Plugin } from '@bge/database';
import { PluginScope } from '@bge/database';
import { PluginUnitPluginNotFoundError, PluginUnitPluginTombstonedError, PluginUnitScopeError } from './unit.errors';

/**
 * The plugin a per-unit writer addresses, with its manifest: 404 for an
 * unknown slug, 410 for an uninstalled one. One copy, so the unit lifecycle
 * and the consent act cannot disagree about either refusal (#1150).
 *
 * `Plugin.enabled`, the server switch, does not gate a unit write: consenting
 * or configuring before the operator switches the plugin on is a legitimate
 * order (#225).
 */
export async function loadLivingPlugin(db: Pick<DatabaseService, 'plugin'>, slug: string): Promise<Plugin> {
  const plugin = await db.plugin.findUnique({ where: { slug } });

  if (plugin === null) {
    throw new PluginUnitPluginNotFoundError(slug);
  }

  if (plugin.uninstalledAt !== null) {
    throw new PluginUnitPluginTombstonedError(plugin.slug, plugin.uninstalledAt);
  }

  return plugin;
}

/**
 * A server-scope plugin has no per-household enablement surface: the manifest
 * gate's rule, enforced at the writers too. Takes the scope on its own because
 * each writer judges it twice, on the row it read before its transaction and
 * on the one it re-reads under the plugin row's share lock.
 */
export function assertHouseholdSurface(slug: string, scope: PluginScope): void {
  if (scope !== PluginScope.Household) {
    throw new PluginUnitScopeError(slug, scope.toLowerCase());
  }
}
