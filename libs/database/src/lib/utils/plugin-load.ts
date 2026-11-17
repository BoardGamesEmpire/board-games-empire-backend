import type { PrismaClient } from '../client';
import { PluginCategory } from '../client';

/**
 * A load record whose heartbeat is older than this no longer protects its
 * artifact directory from the sweep (#1094): the process that wrote it died
 * without cleaning up. Five missed heartbeats, so a slow database or a
 * paused process does not unprotect code it still runs.
 */
export const PLUGIN_LOAD_STALE_MS = 5 * 60_000;

/**
 * The process role that loads plugins of this category (#1083): the
 * coordinator runs data-gateway plugins, and the api runs every other
 * category. The one place that is decided: each app takes its
 * `loadCategories` from {@link categoriesLoadedBy}, and a process that
 * doesn't load a plugin asks this which process role's load records to read.
 */
export function roleLoading(category: PluginCategory): string {
  return category === PluginCategory.DataGateway ? 'coordinator' : 'api';
}

/**
 * The plugin categories a process of `processRole` loads: those
 * {@link roleLoading} gives it (#1083). Each category goes to exactly one
 * process role, so a category added later loads in the process role
 * `roleLoading` names, and nowhere else.
 */
export function categoriesLoadedBy(processRole: string): PluginCategory[] {
  return Object.values(PluginCategory).filter((category) => roleLoading(category) === processRole);
}

/**
 * Whether a running process of `processRole` has loaded this install of the
 * plugin (#1083): one of its load records names the install's `installedAt`,
 * says the load completed, and has a heartbeat the artifact sweep still
 * honours. The process role matters because an update can move a plugin
 * into another category without a reinstall: until the process of the old
 * process role restarts, its fresh record names the same install although
 * the process role that now loads it has not.
 *
 * One query and no cache, since the gateway worker asks on every call it
 * routes: a cached answer would outlive a clean shutdown, which deletes the
 * records so the next ask sees the plugin is no longer loaded.
 */
export async function hasLivePluginLoad(
  db: Pick<PrismaClient, 'pluginProcessLoad'>,
  plugin: { readonly slug: string; readonly installedAt: Date },
  processRole: string,
  now: Date = new Date(),
): Promise<boolean> {
  // `gt`, because the sweep deletes a record whose heartbeat is at the bound
  // or older (`lte`): the two meet without a gap or an overlap.
  const record = await db.pluginProcessLoad.findFirst({
    where: {
      slug: plugin.slug,
      processRole,
      installedAt: plugin.installedAt,
      ready: true,
      heartbeatAt: { gt: new Date(now.getTime() - PLUGIN_LOAD_STALE_MS) },
    },
    select: { slug: true },
  });

  return record !== null;
}
