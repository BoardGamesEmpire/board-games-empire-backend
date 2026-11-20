import type { GatewayServiceClient } from '@boardgamesempire/proto-gateway';
import type { DataGatewayDriver } from './data-gateway-driver.js';

/**
 * What a data-gateway plugin's factory returns: the function the server
 * calls each time it needs a driver. May be async: a driver may need
 * starting before its first call.
 *
 * Each call returns a new driver, never one that another call returned. The
 * server disposes every driver it is handed, including one that arrives
 * after the server stopped waiting for it, so a driver two calls shared
 * would be disposed while the server still used it (#1083).
 *
 * The server waits only so long for a driver. It can stop waiting, but it
 * can't stop the driver factory, so one that waits on its upstream gives up
 * by itself, on a time limit of its own.
 */
export type DataGatewayDriverFactory = () => DataGatewayDriver | Promise<DataGatewayDriver>;

/**
 * Every operation of the gateway gRPC protocol, the calls a
 * {@link DataGatewayDriver} answers. {@link isDataGatewayDriver} checks a
 * driver by this list, so it names each RPC and nothing else (#1083).
 */
export const DATA_GATEWAY_DRIVER_OPERATIONS = [
  'ping',
  'check',
  'describe',
  'searchGames',
  'fetchGame',
  'fetchGames',
  'fetchExpansions',
  'listLanguages',
  'listPlatforms',
  'listCategories',
  'listMechanics',
  'findUpstreamAccount',
] as const satisfies readonly (keyof GatewayServiceClient)[];

type ListedOperation = (typeof DATA_GATEWAY_DRIVER_OPERATIONS)[number];

/**
 * Accepts only `never`, so an RPC missing from the list above fails this
 * package's build, naming the RPC, until it is listed (#1083).
 */
type EveryRpcListed<Unlisted extends never> = Unlisted;

/** The name of one operation a {@link DataGatewayDriver} answers. */
export type DataGatewayDriverOperation =
  ListedOperation | EveryRpcListed<Exclude<keyof GatewayServiceClient, ListedOperation>>;

const DRIVER_METHODS = [...DATA_GATEWAY_DRIVER_OPERATIONS, 'dispose'] as const;

/** Whether a data-gateway plugin's factory returned a driver factory: any function (#1083). */
export function isDataGatewayDriverFactory(product: unknown): product is DataGatewayDriverFactory {
  return typeof product === 'function';
}

/**
 * Whether `value` is a driver: every operation and `dispose` is a function.
 * It calls none of them, so checking a driver costs its upstream nothing (#1083).
 */
export function isDataGatewayDriver(value: unknown): value is DataGatewayDriver {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false;
  }

  return DRIVER_METHODS.every((method) => typeof Reflect.get(value, method) === 'function');
}
