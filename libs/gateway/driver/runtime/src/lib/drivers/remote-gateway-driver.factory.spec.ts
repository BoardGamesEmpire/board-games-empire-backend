import { AuthType } from '@bge/database';
import { pingWithRetry, walkDir } from '@bge/utils';
import type { Interceptor } from '@grpc/grpc-js';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import * as path from 'node:path';
import { EMPTY, of } from 'rxjs';
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

  // The gateway worker reaches a plugin DataGateway through the coordinator,
  // and names the DataGateway and the actor in the metadata of every call,
  // the connect ping among them: the coordinator refuses a call without them.
  it('passes the interceptors it is given to the channel options of the client it pings and hands out (#1083)', async () => {
    const serviceClient = { ping: jest.fn() };
    const proxy = makeProxy(serviceClient);
    const create = jest.spyOn(ClientProxyFactory, 'create').mockReturnValue(proxy as never);
    (pingWithRetry as jest.Mock).mockResolvedValue({ status: 'SERVING' });
    const interceptors: Interceptor[] = [jest.fn(), jest.fn()];

    await factory.create(options, { interceptors });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ options: { channelOptions: { interceptors } } });
    expect(pingWithRetry).toHaveBeenLastCalledWith(serviceClient, 'bgg', expect.anything());
  });

  // A remote DataGateway is dialled with nothing added to its calls.
  it('builds the client with no channel options when it is given no interceptors (#1083)', async () => {
    const create = jest.spyOn(ClientProxyFactory, 'create').mockReturnValue(makeProxy({ ping: jest.fn() }) as never);
    (pingWithRetry as jest.Mock).mockResolvedValue({ status: 'SERVING' });

    await factory.create(options);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      transport: Transport.GRPC,
      options: { url: 'http://gateway:50051', package: 'bge.gateway.v1' },
    });
    expect(create.mock.calls[0][0].options).not.toHaveProperty('channelOptions');
  });

  // Each app's build copies the gateway proto tree beside its bundle, which
  // is where this file is compiled into.
  it('reads the gateway protos from beside the file it is compiled into (#1083)', async () => {
    const create = jest.spyOn(ClientProxyFactory, 'create').mockReturnValue(makeProxy({ ping: jest.fn() }) as never);
    (pingWithRetry as jest.Mock).mockResolvedValue({ status: 'SERVING' });

    await factory.create(options);

    const besideIt = path.join(__dirname, 'proto');
    expect(walkDir).toHaveBeenLastCalledWith(besideIt, expect.anything(), expect.anything());
    expect(create.mock.calls[0][0]).toMatchObject({ options: { loader: { includeDirs: [besideIt] } } });
  });

  // A process that is no bundle has no proto tree beside this file: the
  // coordinator's e2e suite runs the gateway worker's plugin driver source
  // in its test process, and points it at the built coordinator's protos.
  it('reads the gateway protos from the directory a subclass names instead (#1083)', async () => {
    class ProtosElsewhereFactory extends RemoteGatewayDriverFactory {
      protected override protoDirectory(): string {
        return '/elsewhere/proto';
      }
    }

    const create = jest.spyOn(ClientProxyFactory, 'create').mockReturnValue(makeProxy({ ping: jest.fn() }) as never);
    (pingWithRetry as jest.Mock).mockResolvedValue({ status: 'SERVING' });

    await new ProtosElsewhereFactory(new GatewayCredentialsFactory()).create(options);

    expect(walkDir).toHaveBeenLastCalledWith('/elsewhere/proto', expect.anything(), expect.anything());
    expect(create.mock.calls[0][0]).toMatchObject({ options: { loader: { includeDirs: ['/elsewhere/proto'] } } });
  });

  describe('RemoteGatewayDriver delegation', () => {
    it('delegates every port method to the verified client and dispose to the proxy', async () => {
      const serviceClient = {
        ping: jest.fn().mockReturnValue(of({})),
        check: jest.fn().mockReturnValue(of({})),
        describe: jest.fn().mockReturnValue(of({})),
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
      driver.describe({ correlationId: 'c' });
      driver.searchGames({ correlationId: 'c', query: 'catan' });
      driver.fetchGame({ correlationId: 'c', externalId: 'x' });
      driver.fetchExpansions({ correlationId: 'c', baseExternalId: 'x' });
      driver.listLanguages({ correlationId: 'c' });

      expect(serviceClient.describe).toHaveBeenCalledWith({ correlationId: 'c' });
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
