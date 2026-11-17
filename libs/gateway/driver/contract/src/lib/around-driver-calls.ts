import type { Observable } from 'rxjs';
import type { DataGatewayDriver } from './data-gateway-driver.js';

/**
 * `driver` with every operation's call and subscription run through `around`.
 * `dispose` and `handleInbound` pass through.
 *
 * `around` gets a `call` that invokes the driver's operation with its
 * request, and the operation runs only when `around` runs `call`, so `around`
 * can set up whatever the call needs first: the coordinator runs it inside
 * the plugin's actor scope, and the gateway worker runs a call made outside
 * any actor scope as the system (#1083). The driver given is left untouched.
 */
export function aroundDriverCalls(
  driver: DataGatewayDriver,
  around: <T>(call: () => Observable<T>) => Observable<T>,
): DataGatewayDriver {
  // Spelled out per operation rather than looped over
  // DATA_GATEWAY_DRIVER_OPERATIONS: a loop can't keep each operation's
  // request and answer types without a cast, and a new RPC fails this
  // object's type until it is wrapped here too.
  const wrapped: DataGatewayDriver = {
    ping: (request) => around(() => driver.ping(request)),
    check: (request) => around(() => driver.check(request)),
    describe: (request) => around(() => driver.describe(request)),
    searchGames: (request) => around(() => driver.searchGames(request)),
    fetchGame: (request) => around(() => driver.fetchGame(request)),
    fetchGames: (request) => around(() => driver.fetchGames(request)),
    fetchExpansions: (request) => around(() => driver.fetchExpansions(request)),
    listLanguages: (request) => around(() => driver.listLanguages(request)),
    listPlatforms: (request) => around(() => driver.listPlatforms(request)),
    listCategories: (request) => around(() => driver.listCategories(request)),
    listMechanics: (request) => around(() => driver.listMechanics(request)),
    dispose: () => driver.dispose(),
  };

  if (driver.handleInbound) {
    wrapped.handleInbound = driver.handleInbound.bind(driver);
  }

  return wrapped;
}
