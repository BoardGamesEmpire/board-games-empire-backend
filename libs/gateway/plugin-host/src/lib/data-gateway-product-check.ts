import type { PluginProductCheck } from '@bge/plugin';
import { isDataGatewayDriverFactory } from '@boardgamesempire/gateway-driver-contract';

/**
 * The check a process that hosts data-gateway plugins hands the plugin
 * loader for that plugin category (#1083). A data-gateway plugin's factory
 * returns a driver factory, the function the server calls each time it
 * needs a new driver, so the loader refuses anything that isn't a function
 * before it registers the plugin. Whether the function builds a driver is
 * only known once it is called, at the DataGateway's first use.
 */
export const dataGatewayProductCheck: PluginProductCheck = (product) =>
  isDataGatewayDriverFactory(product) ? null : "a data-gateway plugin's factory must return a driver factory function";
