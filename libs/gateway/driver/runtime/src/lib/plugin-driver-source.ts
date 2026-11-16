import type { PluginCategory } from '@bge/database';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';

/** What a routing decision reads of the plugin behind a plugin DataGateway (#1083). */
export interface RoutedPlugin {
  readonly id: string;
  readonly slug: string;

  /** An update can move a plugin out of the data-gateway category, and its row stays. */
  readonly category: PluginCategory;
  readonly enabled: boolean;
  readonly uninstalledAt: Date | null;
  readonly loadFailed: boolean;

  /** Names the install: a reinstall rewrites it, an update doesn't. */
  readonly installedAt: Date;
}

/**
 * Where the gateway registry gets a plugin DataGateway's driver (#1083). The
 * coordinator and the gateway worker each host a gateway registry and reach a
 * plugin their own way, so each provides its own source under
 * {@link PLUGIN_DRIVER_SOURCE}. A process that provides none refuses every
 * plugin DataGateway as not loaded.
 *
 * `build` must settle, since the registry doesn't time it out: a build that
 * never settles holds every caller of that DataGateway on the one connect
 * they share. When the plugin builds something that isn't a driver, `build`
 * must reject rather than resolve with it. The registry counts a rejected
 * build as a failed connect, toward disabling the DataGateway; a non-driver
 * it resolved with would fail only in the first interview, which is not
 * counted, so the DataGateway would never be disabled.
 *
 * `isLoaded` answers false for a plugin this process can't reach, and rejects
 * only when it couldn't find out. The registry refuses the DataGateway as not
 * loaded for that one decision, logs the failure, and keeps the driver it
 * holds, since nothing says the plugin's copy is gone.
 */
export interface PluginDriverSource {
  /** Whether this process can reach a running copy of this install of the plugin. */
  isLoaded(plugin: RoutedPlugin): Promise<boolean>;

  /** A new driver for the plugin DataGateway. Asked again after a driver is disposed or fails its first interview. */
  build(gatewayId: string, plugin: RoutedPlugin): Promise<DataGatewayDriver>;
}

export const PLUGIN_DRIVER_SOURCE = Symbol('PLUGIN_DRIVER_SOURCE');

/** The Prisma select that reads a {@link RoutedPlugin}. */
export const ROUTED_PLUGIN_FIELDS = {
  id: true,
  slug: true,
  category: true,
  enabled: true,
  uninstalledAt: true,
  loadFailed: true,
  installedAt: true,
} as const;
