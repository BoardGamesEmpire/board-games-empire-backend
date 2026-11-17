import type { PluginFactory } from '@boardgamesempire/plugin-contract';

/**
 * A data-gateway plugin whose factory returns an object where the server
 * expects a driver factory, a function (#1083). The coordinator must refuse
 * it when it loads, and quarantine the plugin.
 */
const plugin: PluginFactory = () => ({});

export default plugin;
