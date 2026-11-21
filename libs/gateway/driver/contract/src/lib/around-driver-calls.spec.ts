import type { Observable } from 'rxjs';
import { defer, lastValueFrom, of } from 'rxjs';
import { aroundDriverCalls } from './around-driver-calls.js';
import { DATA_GATEWAY_DRIVER_OPERATIONS } from './data-gateway-driver-factory.js';
import type { DataGatewayDriver } from './data-gateway-driver.js';
import type { GatewayInboundEvent } from './types.js';

/** A driver whose every operation answers with its own name and the request it was given. */
function fakeDriver(): jest.Mocked<DataGatewayDriver> {
  const answer = (operation: string) => jest.fn((request: unknown) => of({ operation, request }));

  // The fake answers with test values, not the proto messages each operation's type names.
  return {
    ping: answer('ping'),
    check: answer('check'),
    describe: answer('describe'),
    searchGames: answer('searchGames'),
    fetchGame: answer('fetchGame'),
    fetchGames: answer('fetchGames'),
    fetchExpansions: answer('fetchExpansions'),
    listLanguages: answer('listLanguages'),
    listPlatforms: answer('listPlatforms'),
    listCategories: answer('listCategories'),
    listMechanics: answer('listMechanics'),
    findUpstreamAccount: answer('findUpstreamAccount'),
    dispose: jest.fn(),
  } as unknown as jest.Mocked<DataGatewayDriver>;
}

/**
 * An `around` that runs each call as given once its answer is subscribed to,
 * and the record of each time it was asked. Running the call late lets a test
 * see that the operation waits for `around`.
 */
function passThrough() {
  const asked = jest.fn();

  const around = <T>(call: () => Observable<T>): Observable<T> => {
    asked();

    return defer(call);
  };

  return { around, asked };
}

/**
 * The coordinator runs each call a plugin's driver makes inside the plugin's
 * actor scope, and the gateway worker runs a call made outside any actor
 * scope as the system; both wrap the driver with aroundDriverCalls (#1083).
 */
describe('aroundDriverCalls', () => {
  it.each(DATA_GATEWAY_DRIVER_OPERATIONS)(
    'hands %s to around once, runs it only when around runs the call, with its request, and answers what around returns (#1083)',
    async (operation) => {
      const driver = fakeDriver();
      const { around, asked } = passThrough();
      const request = { correlationId: `for-${operation}` };

      // Each operation takes its own request type; the test picks one by name at run time.
      const call = aroundDriverCalls(driver, around)[operation] as (request: unknown) => Observable<unknown>;
      const answer = call(request);

      expect(asked).toHaveBeenCalledTimes(1);
      expect(driver[operation]).not.toHaveBeenCalled();

      await expect(lastValueFrom(answer)).resolves.toEqual({ operation, request });
      expect(asked).toHaveBeenCalledTimes(1);
      expect(driver[operation]).toHaveBeenCalledTimes(1);
      expect(driver[operation]).toHaveBeenCalledWith(request);
    },
  );

  it('answers what around returns, not what the operation does (#1083)', async () => {
    const replaced = of({ correlationId: 'from-around' });

    // An around that answers with its own value for every call: the test reads
    // the answer untyped, so it needn't be the message the operation's type names.
    const wrapped = aroundDriverCalls(fakeDriver(), <T>() => replaced as Observable<T>);

    await expect(lastValueFrom(wrapped.ping({ correlationId: 'c' }))).resolves.toEqual({
      correlationId: 'from-around',
    });
  });

  it('calls around once per call (#1083)', async () => {
    const { around, asked } = passThrough();
    const wrapped = aroundDriverCalls(fakeDriver(), around);

    await lastValueFrom(wrapped.ping({ correlationId: 'one' }));
    await lastValueFrom(wrapped.ping({ correlationId: 'two' }));
    await lastValueFrom(wrapped.describe({}));

    expect(asked).toHaveBeenCalledTimes(3);
  });

  it('leaves dispose unwrapped: it disposes the driver, as the driver, without calling around (#1083)', async () => {
    const driver = fakeDriver();
    const { around, asked } = passThrough();

    await aroundDriverCalls(driver, around).dispose();

    expect(driver.dispose).toHaveBeenCalledTimes(1);
    expect(driver.dispose.mock.contexts[0]).toBe(driver);
    expect(asked).not.toHaveBeenCalled();
  });

  it('passes handleInbound through, run as the driver, when the driver has it (#1083)', async () => {
    const driver = fakeDriver();
    const handleInbound = jest.fn().mockResolvedValue(undefined);
    driver.handleInbound = handleInbound;
    const { around, asked } = passThrough();
    const event: GatewayInboundEvent = {
      topic: 'igdb.game.updated',
      kind: 'updated',
      payload: {},
      receivedAt: new Date('2026-11-16T00:00:00Z'),
    };

    await aroundDriverCalls(driver, around).handleInbound?.(event);

    expect(handleInbound).toHaveBeenCalledWith(event);
    expect(handleInbound.mock.contexts[0]).toBe(driver);
    expect(asked).not.toHaveBeenCalled();
  });

  it('has no handleInbound when the driver has none (#1083)', () => {
    expect(aroundDriverCalls(fakeDriver(), passThrough().around)).not.toHaveProperty('handleInbound');
  });

  it('returns a new driver and leaves the one it was given untouched (#1083)', () => {
    const driver = fakeDriver();
    const before = { ...driver };

    const wrapped = aroundDriverCalls(driver, passThrough().around);

    expect(wrapped).not.toBe(driver);
    expect(Object.keys(driver)).toEqual(Object.keys(before));
    for (const [name, method] of Object.entries(before)) {
      expect(Reflect.get(driver, name)).toBe(method);
    }
  });
});
