import { EMPTY } from 'rxjs';
import {
  DATA_GATEWAY_DRIVER_OPERATIONS,
  isDataGatewayDriver,
  isDataGatewayDriverFactory,
} from './data-gateway-driver-factory.js';

/** An object with every driver method, each answering nothing. */
function driverShape(): Record<string, unknown> {
  return {
    ping: () => EMPTY,
    check: () => EMPTY,
    describe: () => EMPTY,
    searchGames: () => EMPTY,
    fetchGame: () => EMPTY,
    fetchGames: () => EMPTY,
    fetchExpansions: () => EMPTY,
    listLanguages: () => EMPTY,
    listPlatforms: () => EMPTY,
    listCategories: () => EMPTY,
    listMechanics: () => EMPTY,
    dispose: () => undefined,
  };
}

/**
 * A data-gateway plugin's factory returns a driver factory, and the server
 * checks what it gets before calling it or the driver it makes (#1083).
 */
describe('data-gateway driver factory contract', () => {
  it('lists every operation of the gateway gRPC protocol (#1083)', () => {
    expect(DATA_GATEWAY_DRIVER_OPERATIONS).toEqual([
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
    ]);
  });

  describe('isDataGatewayDriverFactory', () => {
    it('accepts an arrow function (#1083)', () => {
      expect(isDataGatewayDriverFactory(() => driverShape())).toBe(true);
    });

    it('accepts an async function, since a driver may need starting before its first call (#1083)', () => {
      expect(isDataGatewayDriverFactory(async () => driverShape())).toBe(true);
    });

    it('refuses an object, even a driver (#1083)', () => {
      expect(isDataGatewayDriverFactory(driverShape())).toBe(false);
    });

    it('refuses undefined and null (#1083)', () => {
      expect(isDataGatewayDriverFactory(undefined)).toBe(false);
      expect(isDataGatewayDriverFactory(null)).toBe(false);
    });
  });

  describe('isDataGatewayDriver', () => {
    it('accepts a value whose every operation and dispose is a function (#1083)', () => {
      expect(isDataGatewayDriver(driverShape())).toBe(true);
    });

    it('refuses a driver missing fetchGames (#1083)', () => {
      const withoutFetchGames = driverShape();
      delete withoutFetchGames['fetchGames'];

      expect(isDataGatewayDriver(withoutFetchGames)).toBe(false);
    });

    it('refuses a driver missing dispose (#1083)', () => {
      const withoutDispose = driverShape();
      delete withoutDispose['dispose'];

      expect(isDataGatewayDriver(withoutDispose)).toBe(false);
    });

    it('refuses a driver whose operation is not a function (#1083)', () => {
      expect(isDataGatewayDriver({ ...driverShape(), listMechanics: 'listMechanics' })).toBe(false);
    });

    it('calls none of the methods it checks (#1083)', () => {
      const shape = Object.fromEntries(Object.keys(driverShape()).map((name) => [name, jest.fn()]));

      isDataGatewayDriver(shape);

      for (const method of Object.values(shape)) {
        expect(method).not.toHaveBeenCalled();
      }
    });

    it('refuses undefined, null and a string (#1083)', () => {
      expect(isDataGatewayDriver(undefined)).toBe(false);
      expect(isDataGatewayDriver(null)).toBe(false);
      expect(isDataGatewayDriver('driver')).toBe(false);
    });
  });
});
