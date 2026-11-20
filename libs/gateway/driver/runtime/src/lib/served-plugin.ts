import type { Prisma } from '@bge/database';
import { PluginCategory } from '@bge/database';
import type { RoutedPlugin } from './plugin-driver-source';

/**
 * Whether the server serves a plugin DataGateway's plugin: still a
 * data-gateway plugin, switched on, installed, and not quarantined by a failed
 * load (#1083). An update can move a plugin to another category, and the row
 * it leaves behind is then no plugin's to serve. {@link PLUGIN_SERVED_WHERE}
 * states the same rule for the database.
 */
export const isPluginServed = (plugin: RoutedPlugin): boolean =>
  plugin.category === PluginCategory.DataGateway &&
  plugin.enabled &&
  plugin.uninstalledAt === null &&
  !plugin.loadFailed;

/**
 * {@link isPluginServed} as a filter on DataGateway rows: a remote DataGateway,
 * or a plugin DataGateway whose plugin the server serves. A read that picks a
 * DataGateway to route to puts it in its `where`, so it never picks one that
 * routing refuses for its plugin (#1083, #1226). The plugin-served spec holds
 * the two to the same cases.
 */
export const PLUGIN_SERVED_WHERE: Prisma.DataGatewayWhereInput = {
  OR: [
    { pluginId: null },
    {
      plugin: {
        is: { category: PluginCategory.DataGateway, enabled: true, uninstalledAt: null, loadFailed: false },
      },
    },
  ],
};
