import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import { dataGatewayProductCheck } from './data-gateway-product-check';

const REFUSAL = "a data-gateway plugin's factory must return a driver factory function";

/**
 * The coordinator's check of what a data-gateway plugin's factory returned,
 * run by the plugin loader before it registers the plugin: a reason
 * quarantines the plugin (#1083).
 */
describe('dataGatewayProductCheck', () => {
  it('adopts a function, sync or async: the driver factory the coordinator calls for each driver (#1083)', () => {
    expect(dataGatewayProductCheck(() => new InMemoryGatewayDriver())).toBeNull();
    expect(dataGatewayProductCheck(async () => new InMemoryGatewayDriver())).toBeNull();
  });

  // The first is the mistake an author is likeliest to make: returning the
  // driver itself, where the server asks for a function that builds one.
  it.each<[string, unknown]>([
    ['a driver, not a function that builds one', new InMemoryGatewayDriver()],
    ['nothing', undefined],
    ['null', null],
    ['a plain object', { create: () => new InMemoryGatewayDriver() }],
    ['a string', 'driver'],
  ])('refuses %s, saying what the factory must return (#1083)', (_what, product) => {
    expect(dataGatewayProductCheck(product)).toBe(REFUSAL);
  });
});
