import { SystemActorScope } from '@bge/actor-context';
import { AuthType, DatabaseService } from '@bge/database';
import { CACHE_REDIS_CLIENT } from '@bge/redis';
import type { GameGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type { Redis } from 'iovalkey';
import { FAILURE_THRESHOLD } from './constants/gateway-registry.constants';
import { RemoteGatewayDriverFactory } from './drivers/remote-gateway-driver.factory';
import { GatewayDisabledEvent } from './events/gateway-registry.events';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayLanguageSyncService } from './gateway-language-sync.service';
import { GatewayRegistryService } from './gateway-registry.service';
import type { GatewayConfigEvent } from './interfaces';

describe('GatewayRegistryService', () => {
  let service: GatewayRegistryService;
  let db: { gameGateway: { updateMany: jest.Mock; findFirst: jest.Mock } };
  let emitter: EventEmitter2;
  let systemActorScope: { run: jest.Mock };
  let factory: { create: jest.Mock };

  /**
   * Builds a driver double satisfying the port surface. The registry treats
   * drivers opaquely, so the RPC methods only need to exist.
   */
  const makeDriver = (): GameGatewayDriver & { dispose: jest.Mock } =>
    ({
      ping: jest.fn(),
      check: jest.fn(),
      searchGames: jest.fn(),
      fetchGame: jest.fn(),
      fetchExpansions: jest.fn(),
      listLanguages: jest.fn(),
      dispose: jest.fn(),
    }) as unknown as GameGatewayDriver & { dispose: jest.Mock };

  /** Routes the factory to a ready driver, as a successful remote connect would. */
  const stubFactory = (driver: GameGatewayDriver = makeDriver()): GameGatewayDriver => {
    factory.create.mockResolvedValue(driver);
    return driver;
  };

  const gatewayRow = {
    id: 'bgg',
    name: 'BGG',
    connectionUrl: 'http://gateway',
    connectionPort: 50051,
    authType: AuthType.None,
    authParameters: null,
  };

  const connectOpts = {
    gatewayId: 'bgg',
    connectionUrl: 'http://gateway',
    connectionPort: 50051,
    authType: AuthType.None,
  };

  const dispatch = (event: GatewayConfigEvent): Promise<void> =>
    (service as unknown as { handleConfigUpdate(e: GatewayConfigEvent): Promise<void> }).handleConfigUpdate(event);

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
    systemActorScope = { run: jest.fn((_reason: string, fn: () => unknown) => fn()) };
    factory = { create: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        GatewayRegistryService,
        GatewayConfigEventsService,
        EventEmitter2,
        { provide: RemoteGatewayDriverFactory, useValue: factory },
        { provide: DatabaseService, useValue: db },
        { provide: CACHE_REDIS_CLIENT, useValue: redisMock },
        { provide: SystemActorScope, useValue: systemActorScope },
        { provide: GatewayLanguageSyncService, useValue: { syncIfStale: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(GatewayRegistryService);
    emitter = module.get(EventEmitter2);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('reports no connected gateways initially', () => {
    expect(service.connectedGatewayIds()).toEqual([]);
  });

  describe('resolve (lazy connect)', () => {
    it('connects from DB config on a cache miss and returns the driver', async () => {
      db.gameGateway.findFirst.mockResolvedValue(gatewayRow);
      const driver = stubFactory();

      const result = await service.resolve('bgg');

      expect(factory.create).toHaveBeenCalledTimes(1);
      expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: 'bgg', connectionPort: 50051 }));
      expect(result).toBe(driver);
    });

    it('getServiceClient is a deprecated alias returning the same driver', async () => {
      db.gameGateway.findFirst.mockResolvedValue(gatewayRow);
      const driver = stubFactory();

      const client = await service.getServiceClient('bgg');

      expect(client).toBe(driver);
    });

    it('deduplicates concurrent connects for the same gateway', async () => {
      db.gameGateway.findFirst.mockResolvedValue(gatewayRow);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      factory.create.mockImplementation(async () => {
        await gate;
        return makeDriver();
      });

      const inFlight = Promise.all([service.resolve('bgg'), service.resolve('bgg')]);
      release();
      await inFlight;

      expect(factory.create).toHaveBeenCalledTimes(1);
    });

    it('throws and does not connect when the gateway is absent/disabled/deleted', async () => {
      db.gameGateway.findFirst.mockResolvedValue(null);
      stubFactory();

      await expect(service.resolve('gone')).rejects.toThrow(/not available/);
      expect(factory.create).not.toHaveBeenCalled();
    });
  });

  describe('register (in-process drivers)', () => {
    it('routes a registered driver without touching the DB or the remote factory', async () => {
      const driver = new InMemoryGatewayDriver({ gatewayName: 'in-proc' });

      service.register('plugin-bgg', driver);

      await expect(service.resolve('plugin-bgg')).resolves.toBe(driver);
      expect(db.gameGateway.findFirst).not.toHaveBeenCalled();
      expect(factory.create).not.toHaveBeenCalled();
      expect(service.isConnected('plugin-bgg')).toBe(true);
    });

    it('disconnect disposes a registered driver', () => {
      const driver = new InMemoryGatewayDriver();
      service.register('plugin-bgg', driver);

      service.disconnect('plugin-bgg');

      expect(driver.disposed).toBe(true);
      expect(service.isConnected('plugin-bgg')).toBe(false);
    });

    it('disposes an evicted driver when a new one is registered under the same id', () => {
      const evicted = makeDriver();
      service.register('bgg', evicted);
      const replacement = makeDriver();

      service.register('bgg', replacement);

      // No leaked channel: the displaced driver is torn down, the new one kept.
      expect(evicted.dispose).toHaveBeenCalledTimes(1);
      expect(replacement.dispose).not.toHaveBeenCalled();
    });
  });

  // Regression: an eager bootstrap connect and a job-triggered lazy resolve for
  // the same gateway race. Neither should leak — whichever driver loses the
  // cache slot must be disposed. Ordering-agnostic on purpose (last write by
  // completion order wins; we assert only the no-leak invariant).
  describe('concurrent connect race (no leak)', () => {
    it('disposes exactly the driver that loses the cache slot', async () => {
      db.gameGateway.findFirst.mockResolvedValue(gatewayRow);
      const a = makeDriver();
      const b = makeDriver();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      factory.create
        .mockImplementationOnce(async () => {
          await gate;
          return a;
        })
        .mockResolvedValueOnce(b);

      const lazy = service.resolve('bgg'); // factory call #1 (gated → a)
      const explicit = service.connect(connectOpts); // factory call #2 → b
      release();
      await Promise.all([lazy, explicit]);

      const survivor = (await service.resolve('bgg')) as GameGatewayDriver & { dispose: jest.Mock };
      const evicted = (survivor === a ? b : a) as GameGatewayDriver & { dispose: jest.Mock };
      expect(evicted.dispose).toHaveBeenCalledTimes(1);
      expect(survivor.dispose).not.toHaveBeenCalled();
    });
  });

  describe('connect (mid-connect invalidation race)', () => {
    it('discards the freshly-connected driver when a disable event arrives during the ping', async () => {
      const driver = makeDriver();

      // Gate the factory so we can inject a disable event while connect() is suspended.
      let releaseCreate!: () => void;
      const createPending = new Promise<void>((resolve) => (releaseCreate = resolve));
      factory.create.mockImplementation(async () => {
        await createPending;
        return driver;
      });

      const connecting = service.connect(connectOpts);

      // Mid-connect: nothing is cached yet, so the old code's disconnect no-oped.
      // The generation bump must still invalidate this in-flight connect.
      await dispatch({ gatewayId: 'bgg', configHash: '', changeType: 'disabled', timestamp: 0 });

      releaseCreate();
      await connecting;

      expect(service.isConnected('bgg')).toBe(false);
      expect(driver.dispose).toHaveBeenCalledTimes(1);
    });

    it('discards the freshly-connected driver when a config-change event arrives during the ping', async () => {
      const driver = makeDriver();

      // Gate the factory so we can inject an 'updated' event while connect() is suspended.
      let releaseCreate!: () => void;
      const createPending = new Promise<void>((resolve) => (releaseCreate = resolve));
      factory.create.mockImplementation(async () => {
        await createPending;
        return driver;
      });

      const connecting = service.connect(connectOpts);

      // Mid-connect: nothing is cached yet, so the old 'updated' branch (guarded
      // by `cached &&`) no-oped and the in-flight connect went on to cache a
      // driver for the now-superseded config. The generation bump must
      // invalidate it — the same guarantee as the disabled case.
      await dispatch({ gatewayId: 'bgg', configHash: 'new-hash', changeType: 'updated', timestamp: 0 });

      releaseCreate();
      await connecting;

      expect(service.isConnected('bgg')).toBe(false);
      expect(driver.dispose).toHaveBeenCalledTimes(1);
    });

    it('caches the driver normally when nothing invalidates it during connect', async () => {
      const driver = stubFactory() as GameGatewayDriver & { dispose: jest.Mock };

      await service.connect(connectOpts);

      expect(service.isConnected('bgg')).toBe(true);
      expect(driver.dispose).not.toHaveBeenCalled();
    });

    it('feeds connection failures into failure tracking and rethrows', async () => {
      factory.create.mockRejectedValue(new Error('unreachable'));

      await expect(service.connect(connectOpts)).rejects.toThrow('unreachable');
      expect(service.isConnected('bgg')).toBe(false);
    });
  });

  describe('handleConfigUpdate', () => {
    it('reconnect-requested drops the existing REMOTE driver and eagerly reconnects', async () => {
      // Seed a remote-origin cached driver by driving a real connect() first.
      // register() would tag it 'registered', which handleConfigUpdate now
      // intentionally exempts from reconnect events (see the in-process test
      // below) — reconnect only applies to remote connections.
      db.gameGateway.findFirst.mockResolvedValue(gatewayRow);
      const oldDriver = stubFactory() as GameGatewayDriver & { dispose: jest.Mock };
      await service.connect(connectOpts); // origin: 'remote'
      expect(service.isConnected('bgg')).toBe(true);

      const newDriver = makeDriver();
      factory.create.mockResolvedValue(newDriver);

      await dispatch({ gatewayId: 'bgg', configHash: 'x', changeType: 'reconnect-requested', timestamp: 0 });

      expect(oldDriver.dispose).toHaveBeenCalledTimes(1);
      // Two creates: the seed connect above + the eager reconnect.
      expect(factory.create).toHaveBeenCalledTimes(2);
      expect(service.isConnected('bgg')).toBe(true);
    });

    it('ignores updated/reconnect-requested for registered in-process drivers', async () => {
      const driver = new InMemoryGatewayDriver();
      service.register('plugin-bgg', driver);

      await dispatch({ gatewayId: 'plugin-bgg', configHash: 'h', changeType: 'updated', timestamp: 0 });
      await dispatch({ gatewayId: 'plugin-bgg', configHash: 'h', changeType: 'reconnect-requested', timestamp: 0 });

      // The plugin driver survives and connectFromDb is never consulted — an
      // in-process driver must not be silently swapped for a remote one.
      expect(driver.disposed).toBe(false);
      expect(service.isConnected('plugin-bgg')).toBe(true);
      expect(factory.create).not.toHaveBeenCalled();
    });

    it('still tears down a registered driver on disabled (admin intent wins)', async () => {
      const driver = new InMemoryGatewayDriver();
      service.register('plugin-bgg', driver);

      await dispatch({ gatewayId: 'plugin-bgg', configHash: '', changeType: 'disabled', timestamp: 0 });

      expect(driver.disposed).toBe(true);
      expect(service.isConnected('plugin-bgg')).toBe(false);
    });

    it('reconnect-requested swallows reconnect failures (no throw out of the handler)', async () => {
      db.gameGateway.findFirst.mockResolvedValue(null);

      await expect(
        dispatch({ gatewayId: 'bgg', configHash: 'x', changeType: 'reconnect-requested', timestamp: 0 }),
      ).resolves.toBeUndefined();
    });
  });

  describe('auto-disable (failure tracking)', () => {
    const failUntilThreshold = async (gatewayId = 'bgg'): Promise<void> => {
      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        await service.reportFailure(gatewayId, new Error('boom'));
      }
    };

    it('does not touch the DB below the failure threshold', async () => {
      await service.reportFailure('bgg', new Error('boom'));

      expect(db.gameGateway.updateMany).not.toHaveBeenCalled();
    });

    it('disables the gateway inside a system actor scope and emits a GatewayDisabledEvent', async () => {
      db.gameGateway.updateMany.mockResolvedValue({ count: 1 });
      const emitSpy = jest.spyOn(emitter, 'emit');

      await failUntilThreshold();

      expect(db.gameGateway.updateMany).toHaveBeenCalledWith({
        where: { id: 'bgg', enabled: true },
        data: { enabled: false },
      });
      expect(systemActorScope.run).toHaveBeenCalledWith('gateway-registry:auto-disable', expect.any(Function));

      const [name, emitted] = emitSpy.mock.calls[0] as [string, GatewayDisabledEvent];
      expect(name).toBe(GatewayDisabledEvent.eventName);
      expect(emitted).toBeInstanceOf(GatewayDisabledEvent);
      expect(emitted.action).toBe('update');
      expect(emitted.subjectId).toBe('bgg');
      expect(emitted.before).toEqual({ id: 'bgg', enabled: true });
      expect(emitted.after).toEqual({ id: 'bgg', enabled: false });
      expect(emitted.failure).toEqual(
        expect.objectContaining({
          reason: 'repeated_call_failure',
          consecutiveFailures: FAILURE_THRESHOLD,
          lastError: 'boom',
        }),
      );
    });

    it('does not emit when another process already disabled the gateway', async () => {
      db.gameGateway.updateMany.mockResolvedValue({ count: 0 });
      const emitSpy = jest.spyOn(emitter, 'emit');

      await failUntilThreshold();

      expect(db.gameGateway.updateMany).toHaveBeenCalledTimes(1);
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('is transport-agnostic: a registered in-process driver trips the same threshold and is disposed on disable', async () => {
      db.gameGateway.updateMany.mockResolvedValue({ count: 1 });
      const driver = new InMemoryGatewayDriver();
      driver.failWith(new Error('in-proc boom'));
      service.register('plugin-bgg', driver);

      await failUntilThreshold('plugin-bgg');

      expect(db.gameGateway.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-bgg', enabled: true },
        data: { enabled: false },
      });
      expect(driver.disposed).toBe(true);
      expect(service.isConnected('plugin-bgg')).toBe(false);
    });
  });
});
