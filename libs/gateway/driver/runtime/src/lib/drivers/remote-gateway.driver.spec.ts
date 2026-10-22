import type { GatewayServiceClient } from '@boardgamesempire/proto-gateway';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { RemoteGatewayDriver } from './remote-gateway.driver';

/** Every call the driver forwards to the gateway's gRPC client. */
const CALLS = [
  'ping',
  'check',
  'describe',
  'searchGames',
  'fetchGame',
  'fetchExpansions',
  'listLanguages',
  'listPlatforms',
  'listCategories',
  'listMechanics',
] as const satisfies readonly (keyof GatewayServiceClient)[];

describe('RemoteGatewayDriver', () => {
  let client: Record<(typeof CALLS)[number], jest.Mock>;
  let proxy: { close: jest.Mock };
  let driver: RemoteGatewayDriver;

  beforeEach(() => {
    client = Object.fromEntries(CALLS.map((call) => [call, jest.fn()])) as typeof client;
    proxy = { close: jest.fn() };
    driver = new RemoteGatewayDriver(
      'igdb',
      proxy as unknown as ClientGrpcProxy,
      client as unknown as GatewayServiceClient,
    );
  });

  it.each(CALLS)('forwards %s to the gateway’s client, request and answer as they are', (call) => {
    const request = { correlationId: 'c1' };
    const answer = of({});
    client[call].mockReturnValue(answer);

    const forward = driver[call] as (request: unknown) => unknown;

    expect(forward.call(driver, request)).toBe(answer);
    expect(client[call]).toHaveBeenCalledWith(request);
  });

  it('closes the channel on dispose', () => {
    driver.dispose();

    expect(proxy.close).toHaveBeenCalledTimes(1);
  });

  it('doesn’t throw when closing the channel fails', () => {
    proxy.close.mockImplementation(() => {
      throw new Error('already closed');
    });

    expect(() => driver.dispose()).not.toThrow();
  });
});
