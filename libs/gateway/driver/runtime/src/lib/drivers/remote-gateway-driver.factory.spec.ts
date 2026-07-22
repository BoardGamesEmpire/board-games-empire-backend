import { AuthType } from '@bge/database';
import { pingWithRetry } from '@bge/utils';
import { EMPTY, of } from 'rxjs';
import { ClientProxyFactory, type ClientGrpcProxy } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { GatewayCredentialsFactory } from '../credentials/gateway-credentials.factory';
import { RemoteGatewayDriverFactory } from './remote-gateway-driver.factory';

jest.mock('@bge/utils', () => ({
  pingWithRetry: jest.fn(),
  walkDir: jest.fn(() => []),
}));

describe('RemoteGatewayDriverFactory', () => {
  let factory: RemoteGatewayDriverFactory;

  const options = {
    gatewayId: 'bgg',
    connectionUrl: 'http://gateway',
    connectionPort: 50051,
    authType: AuthType.None,
  };

  const makeProxy = (serviceClient: unknown): Partial<ClientGrpcProxy> => ({
    getService: jest.fn().mockReturnValue(serviceClient),
    close: jest.fn(),
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [RemoteGatewayDriverFactory, GatewayCredentialsFactory],
    }).compile();

    factory = module.get(RemoteGatewayDriverFactory);
  });

  afterEach(() => jest.restoreAllMocks());

  it('builds a driver only after the ping handshake verifies the channel', async () => {
    const serviceClient = { ping: jest.fn(), fetchGame: jest.fn() };
    const proxy = makeProxy(serviceClient);
    // `create` is overloaded; its return type doesn't unify with ClientGrpcProxy
    // (rxjs generic variance), so route the mock value through `never`.
    jest.spyOn(ClientProxyFactory, 'create').mockReturnValue(proxy as never);
    (pingWithRetry as jest.Mock).mockResolvedValue({ status: 'SERVING' });

    const driver = await factory.create(options);

    expect(pingWithRetry).toHaveBeenCalledWith(serviceClient, 'bgg', expect.anything());
    expect(driver.gatewayId).toBe('bgg');
    expect(proxy.close).not.toHaveBeenCalled();
  });

  it('closes the unverified channel and rethrows when the ping fails', async () => {
    const proxy = makeProxy({ ping: jest.fn() });
    jest.spyOn(ClientProxyFactory, 'create').mockReturnValue(proxy as never);
    (pingWithRetry as jest.Mock).mockRejectedValue(new Error('unreachable'));

    await expect(factory.create(options)).rejects.toThrow('unreachable');
    expect(proxy.close).toHaveBeenCalledTimes(1);
  });

  describe('RemoteGatewayDriver delegation', () => {
    it('delegates every port method to the verified client and dispose to the proxy', async () => {
      const serviceClient = {
        ping: jest.fn().mockReturnValue(of({})),
        check: jest.fn().mockReturnValue(of({})),
        searchGames: jest.fn().mockReturnValue(EMPTY),
        fetchGame: jest.fn().mockReturnValue(of({})),
        fetchExpansions: jest.fn().mockReturnValue(EMPTY),
        listLanguages: jest.fn().mockReturnValue(of({})),
      };
      const proxy = makeProxy(serviceClient);
      jest.spyOn(ClientProxyFactory, 'create').mockReturnValue(proxy as never);
      (pingWithRetry as jest.Mock).mockResolvedValue({ status: 'SERVING' });

      const driver = await factory.create(options);

      driver.ping({ correlationId: 'c' });
      driver.check({ service: '' });
      driver.searchGames({ correlationId: 'c', query: 'catan' });
      driver.fetchGame({ correlationId: 'c', externalId: 'x' });
      driver.fetchExpansions({ correlationId: 'c', baseExternalId: 'x' });
      driver.listLanguages({ correlationId: 'c' });

      expect(serviceClient.searchGames).toHaveBeenCalledWith({ correlationId: 'c', query: 'catan' });
      expect(serviceClient.fetchGame).toHaveBeenCalledWith({ correlationId: 'c', externalId: 'x' });
      expect(serviceClient.fetchExpansions).toHaveBeenCalledWith({ correlationId: 'c', baseExternalId: 'x' });

      driver.dispose();
      driver.dispose();
      expect(proxy.close).toHaveBeenCalledTimes(2);
    });

    it('dispose never throws when the underlying close fails', async () => {
      const proxy = makeProxy({ ping: jest.fn() });
      (proxy.close as jest.Mock).mockImplementation(() => {
        throw new Error('already closed');
      });
      jest.spyOn(ClientProxyFactory, 'create').mockReturnValue(proxy as never);
      (pingWithRetry as jest.Mock).mockResolvedValue({ status: 'SERVING' });

      const driver = await factory.create(options);

      expect(() => driver.dispose()).not.toThrow();
    });
  });
});
