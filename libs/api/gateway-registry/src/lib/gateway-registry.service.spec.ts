import { AuthType, DatabaseService } from '@bge/database';
import { CACHE_REDIS_CLIENT } from '@bge/redis';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import type { Redis } from 'iovalkey';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayRegistryService } from './gateway-registry.service';
import type { GatewayConfigEvent } from './interfaces';

// TODO: Failure-tracking tests, race-condition tests, and config-event integration tests

describe('GatewayRegistryService', () => {
  let service: GatewayRegistryService;
  let db: { gameGateway: { updateMany: jest.Mock; findFirst: jest.Mock } };

  /**
   * Builds a fake gRPC proxy whose getService() returns the given service
   * client, and a spy on connect() that caches the proxy as a real connect
   * would — without touching gRPC.
   */
  const stubConnect = (proxy: Partial<ClientGrpcProxy>): jest.SpyInstance =>
    jest.spyOn(service, 'connect').mockImplementation(async (opts) => {
      (service as unknown as { clients: Map<string, unknown> }).clients.set(opts.gatewayId, {
        gatewayId: opts.gatewayId,
        proxy,
        configHash: 'hash',
      });
    });

  const makeProxy = (serviceClient: unknown): Partial<ClientGrpcProxy> => ({
    getService: jest.fn().mockReturnValue(serviceClient),
    close: jest.fn(),
  });

  const gatewayRow = {
    id: 'bgg',
    name: 'BGG',
    connectionUrl: 'http://gateway',
    connectionPort: 50051,
    authType: AuthType.None,
    authParameters: null,
  };

  beforeEach(async () => {
    const redisMock = {
      duplicate: () => redisMock,
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      publish: jest.fn(),
      quit: jest.fn(),
      on: jest.fn(),
    } as unknown as Redis;

    db = { gameGateway: { updateMany: jest.fn(), findFirst: jest.fn() } };

    const module = await Test.createTestingModule({
      providers: [
        GatewayRegistryService,
        GatewayCredentialsFactory,
        GatewayConfigEventsService,
        EventEmitter2,
        { provide: DatabaseService, useValue: db },
        { provide: CACHE_REDIS_CLIENT, useValue: redisMock },
      ],
    }).compile();

    service = module.get(GatewayRegistryService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('reports no connected gateways initially', () => {
    expect(service.connectedGatewayIds()).toEqual([]);
  });

  describe('getServiceClient (lazy connect)', () => {
    it('connects from DB config on a cache miss and returns the service client', async () => {
      const serviceClient = { fetchGame: jest.fn() };
      db.gameGateway.findFirst.mockResolvedValue(gatewayRow);
      const connectSpy = stubConnect(makeProxy(serviceClient));

      const result = await service.getServiceClient('bgg');

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: 'bgg', connectionPort: 50051 }));
      expect(result).toBe(serviceClient);
    });

    it('deduplicates concurrent connects for the same gateway', async () => {
      db.gameGateway.findFirst.mockResolvedValue(gatewayRow);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const connectSpy = jest.spyOn(service, 'connect').mockImplementation(async (opts) => {
        await gate;
        (service as unknown as { clients: Map<string, unknown> }).clients.set(opts.gatewayId, {
          gatewayId: opts.gatewayId,
          proxy: makeProxy({ fetchGame: jest.fn() }),
          configHash: 'hash',
        });
      });

      const inFlight = Promise.all([service.getServiceClient('bgg'), service.getServiceClient('bgg')]);
      release();
      await inFlight;

      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it('throws and does not connect when the gateway is absent/disabled/deleted', async () => {
      db.gameGateway.findFirst.mockResolvedValue(null);
      const connectSpy = stubConnect(makeProxy({}));

      await expect(service.getServiceClient('gone')).rejects.toThrow(/not available/);
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleConfigUpdate', () => {
    const dispatch = (event: GatewayConfigEvent): Promise<void> =>
      (service as unknown as { handleConfigUpdate(e: GatewayConfigEvent): Promise<void> }).handleConfigUpdate(event);

    it('reconnect-requested drops the existing client and eagerly reconnects', async () => {
      const oldProxy = makeProxy({ fetchGame: jest.fn() });
      (service as unknown as { clients: Map<string, unknown> }).clients.set('bgg', {
        gatewayId: 'bgg',
        proxy: oldProxy,
        configHash: 'old',
      });
      db.gameGateway.findFirst.mockResolvedValue(gatewayRow);
      const connectSpy = stubConnect(makeProxy({ fetchGame: jest.fn() }));

      await dispatch({ gatewayId: 'bgg', configHash: 'x', changeType: 'reconnect-requested', timestamp: 0 });

      expect(oldProxy.close).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(service.isConnected('bgg')).toBe(true);
    });

    it('reconnect-requested swallows reconnect failures (no throw out of the handler)', async () => {
      db.gameGateway.findFirst.mockResolvedValue(null);

      await expect(
        dispatch({ gatewayId: 'bgg', configHash: 'x', changeType: 'reconnect-requested', timestamp: 0 }),
      ).resolves.toBeUndefined();
    });
  });
});
