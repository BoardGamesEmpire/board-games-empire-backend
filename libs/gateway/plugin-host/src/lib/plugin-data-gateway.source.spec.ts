import type { Actor } from '@bge/actor-context';
import { AuditContextModule, AuditContextService, SystemActorScope } from '@bge/actor-context';
import { PluginCategory } from '@bge/database';
import type { RoutedPlugin } from '@bge/gateway-registry';
import { GatewayRoutingRefusedError } from '@bge/gateway-registry';
import type { LoadedPlugin } from '@bge/plugin';
import { PluginInstanceRegistry } from '@bge/plugin';
import type { DataGatewayDriver, GatewayInboundEvent } from '@boardgamesempire/gateway-driver-contract';
import { DATA_GATEWAY_DRIVER_OPERATIONS } from '@boardgamesempire/gateway-driver-contract';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { setTimeout as delay } from 'node:timers/promises';
import { concatMap, defer, firstValueFrom, lastValueFrom, map, Observable, of, take, throwError, toArray } from 'rxjs';
import { PLUGIN_DRIVER_BUILD_TIMEOUT_MS, PluginDataGatewaySource } from './plugin-data-gateway.source';
import { PluginDataGatewayBuildError, PluginDataGatewayBuildTimeoutError } from './plugin-host.errors';

/** The plugin DataGateway a driver is built for. */
const GW = 'acme';

const SLUG = 'acme-games';
const PLUGIN_ID = 'plugin-1';
const INSTALLED_AT = '2026-11-01T00:00:00Z';
const REINSTALLED_AT = '2026-11-02T00:00:00Z';

/**
 * The actor whose work reaches the plugin. A spec outside the entry points
 * can put only a system actor in scope, so that is who triggers here.
 */
const TRIGGER: Actor = { kind: 'system', reason: 'a-search-reaches-the-plugin' };

/** What the plugin's code must see as the actor: the plugin as its Server-scope self, with the trigger recorded. */
const THE_PLUGIN_TRIGGERED: Actor = {
  kind: 'plugin',
  pluginId: PLUGIN_ID,
  unit: { scopeType: 'Server' },
  trigger: TRIGGER,
};

const PONG: proto.GatewayPingResponse = {
  correlationId: 'c',
  timestampMs: 0n,
  gatewayName: 'Acme Games',
  gatewayVersion: '1.0.0',
};

const INBOUND: GatewayInboundEvent = {
  topic: 'acme.game.updated',
  kind: 'updated',
  payload: {},
  receivedAt: new Date('2026-11-16T00:00:00Z'),
};

/** Lets work under way go on past one turn of the event loop. */
const settle = () => delay(0);

/** A promise the spec settles itself, to say when a plugin's work ends and how. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settled, failed) => {
    resolve = settled;
    reject = failed;
  });

  return { promise, resolve, reject };
};

/**
 * RxJS loaded a second time, as a plugin that carries its own copy has it:
 * its Observable is another class than the server's.
 */
const anotherCopyOfRxjs = (): typeof import('rxjs') => {
  let copy!: typeof import('rxjs');
  jest.isolateModules(() => {
    copy = jest.requireActual<typeof import('rxjs')>('rxjs');
  });

  return copy;
};

/** Every method a driver must have, as a plain object, so a case can leave one out. */
const driverShape = (): Record<string, unknown> =>
  Object.fromEntries([...DATA_GATEWAY_DRIVER_OPERATIONS, 'dispose'].map((method) => [method, jest.fn()]));

/** The plugin as a routing decision reads it from its row. */
const routedPlugin = (overrides: Partial<RoutedPlugin> = {}): RoutedPlugin => ({
  id: PLUGIN_ID,
  slug: SLUG,
  category: PluginCategory.DataGateway,
  enabled: true,
  uninstalledAt: null,
  loadFailed: false,
  installedAt: new Date(INSTALLED_AT),
  ...overrides,
});

/**
 * The coordinator's plugin driver source: it answers the gateway registry
 * from the plugins this process loaded, and builds each driver through the
 * plugin's driver factory (#1083).
 */
describe('PluginDataGatewaySource', () => {
  let source: PluginDataGatewaySource;
  let plugins: PluginInstanceRegistry;
  let audit: AuditContextService;
  let system: SystemActorScope;

  /** Runs `work` with the trigger as the actor in scope, as a request that reaches the plugin does. */
  const triggered = <T>(work: () => T): T => system.run(TRIGGER.reason, work);

  /**
   * Registers the plugin as the loader does once its factory returned
   * `product`. The source reads which install the copy is of and the
   * product, so the rest of what the loader records is left out.
   */
  const load = (product: unknown, overrides: Partial<LoadedPlugin> = {}): void =>
    plugins.register(
      SLUG,
      {
        pluginId: PLUGIN_ID,
        slug: SLUG,
        category: PluginCategory.DataGateway,
        installedAt: new Date(INSTALLED_AT),
        instance: product,
        ...overrides,
      } as LoadedPlugin,
      { enabled: true },
    );

  /** A driver built from a plugin whose `ping` is `operation`. */
  const driverWhosePing = async (
    operation: (request: proto.GatewayPingRequest) => unknown,
  ): Promise<DataGatewayDriver> => {
    const pluginDriver = new InMemoryGatewayDriver();
    // The plugin's operation may return anything: several cases are about what it does return.
    jest.spyOn(pluginDriver, 'ping').mockImplementation(operation as never);
    load(() => pluginDriver);

    return source.build(GW, routedPlugin());
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } }), AuditContextModule],
      providers: [PluginDataGatewaySource, PluginInstanceRegistry],
    }).compile();

    source = module.get(PluginDataGatewaySource);
    plugins = module.get(PluginInstanceRegistry);
    audit = module.get(AuditContextService);
    system = module.get(SystemActorScope);
  });

  describe('isLoaded', () => {
    // The row's installedAt and the loaded copy's are two Date objects, read
    // at different times, so the install is matched by the time they hold.
    it('is loaded only for the install it loaded (#1083)', async () => {
      load(() => new InMemoryGatewayDriver());

      await expect(source.isLoaded(routedPlugin())).resolves.toBe(true);
      await expect(source.isLoaded(routedPlugin({ installedAt: new Date(REINSTALLED_AT) }))).resolves.toBe(false);
    });

    it('is not loaded when this process holds no plugin by that slug (#1083)', async () => {
      await expect(source.isLoaded(routedPlugin())).resolves.toBe(false);
    });

    it("is not loaded when the copy it holds by that slug is another plugin row's (#1083)", async () => {
      load(() => new InMemoryGatewayDriver(), { pluginId: 'plugin-of-another-row' });

      await expect(source.isLoaded(routedPlugin())).resolves.toBe(false);
    });
  });

  describe('build', () => {
    // The gateway registry asked whether the plugin was loaded before it
    // asked for the driver. A refusal says the copy went in between, which
    // the registry counts as no failure of the DataGateway's.
    it('refuses to build from a copy loaded before a reinstall', async () => {
      const factory = jest.fn(() => new InMemoryGatewayDriver());
      load(factory);

      const refusal = await source
        .build(GW, routedPlugin({ installedAt: new Date(REINSTALLED_AT) }))
        .catch((err: unknown) => err);

      expect(refusal).toBeInstanceOf(GatewayRoutingRefusedError);
      expect(refusal).toMatchObject({ gatewayId: GW, reason: 'plugin_not_loaded' });
      expect(factory).not.toHaveBeenCalled();
    });

    it('refuses to build for a plugin this process never loaded (#1083)', async () => {
      await expect(source.build(GW, routedPlugin())).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        gatewayId: GW,
        reason: 'plugin_not_loaded',
      });
    });

    it("answers an operation from the driver the plugin's factory built, a stream frame by frame (#1083)", async () => {
      const found = { externalId: '13', title: 'Catan' } as proto.GameSearchData;
      load(() => new InMemoryGatewayDriver({ gatewayName: 'Acme Games', searchResults: [found] }));

      const driver = await source.build(GW, routedPlugin());

      await expect(firstValueFrom(driver.ping({ correlationId: 'c' }))).resolves.toMatchObject({
        correlationId: 'c',
        gatewayName: 'Acme Games',
      });
      await expect(
        lastValueFrom(driver.searchGames({ correlationId: 'c', query: 'catan' }).pipe(toArray())),
      ).resolves.toEqual([
        { correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_RESULT, game: found },
        { correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE },
      ]);
    });

    it('awaits an async driver factory', async () => {
      load(async () => {
        await settle();

        return new InMemoryGatewayDriver({ gatewayName: 'Started first' });
      });

      const driver = await source.build(GW, routedPlugin());

      await expect(firstValueFrom(driver.ping({ correlationId: 'c' }))).resolves.toMatchObject({
        gatewayName: 'Started first',
      });
    });

    // The gateway registry asks again after it disposes a driver, or after a
    // first interview fails: each driver it holds is one the plugin built for it.
    it('a second build calls the factory again', async () => {
      const factory = jest.fn(() => new InMemoryGatewayDriver());
      load(factory);

      const first = await source.build(GW, routedPlugin());
      const second = await source.build(GW, routedPlugin());

      expect(factory).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);
    });

    // The registry counts a rejected build as a failed connect, toward
    // disabling the DataGateway. A non-driver it was handed instead would
    // fail only in the first interview, which is not counted.
    it("fails the build when the factory returns something that isn't a driver", async () => {
      const notDrivers: Record<string, unknown> = {
        nothing: undefined,
        'a driver with an operation missing': { ...driverShape(), listMechanics: undefined },
        'a driver with no dispose': { ...driverShape(), dispose: undefined },
      };

      for (const [what, product] of Object.entries(notDrivers)) {
        plugins.clear();
        load(() => product);

        const failure = await source.build(GW, routedPlugin()).catch((err: unknown) => err);

        expect({ what, failure }).toEqual({ what, failure: expect.any(PluginDataGatewayBuildError) });
      }

      // The shape those cases take from is itself a driver, so each fails for what it lacks.
      plugins.clear();
      load(() => driverShape());
      await expect(source.build(GW, routedPlugin())).resolves.toBeDefined();
    });

    // The loader's product check refuses such a plugin when it loads. A copy
    // loaded without the check still never reaches the registry as a driver.
    it('fails the build when what the plugin loaded with is no driver factory (#1083)', async () => {
      load(new InMemoryGatewayDriver());

      await expect(source.build(GW, routedPlugin())).rejects.toBeInstanceOf(PluginDataGatewayBuildError);
    });

    // A failed build's message is the last error an auto-disable keeps, and
    // the server admins are shown it.
    it('says which plugin failed to build a driver, by its slug, in words for a server admin (#1083)', async () => {
      load(() => undefined);

      await expect(source.build(GW, routedPlugin())).rejects.toThrow(
        "Plugin 'acme-games' did not provide a DataGateway driver the server can use. " +
          'The fault is in the plugin: look for an update to it, or report this to the plugin author.',
      );
    });

    it.each<[string, () => unknown]>([
      [
        'throws',
        () => {
          throw new Error('The upstream key is missing');
        },
      ],
      ['rejects', () => Promise.reject(new Error('The upstream key is missing'))],
    ])("fails the build with the plugin's own error when its factory %s (#1083)", async (_how, factory) => {
      load(factory);

      await expect(source.build(GW, routedPlugin())).rejects.toThrow('The upstream key is missing');
    });
  });

  // The gateway registry puts no time limit on a build, and every caller of
  // a DataGateway shares its one connect. A driver factory that waited for
  // ever, on an upstream that never answers, would hold them all, with
  // nothing counted toward auto-disable and nothing logged, until a restart.
  describe('a driver factory that is slow to start its driver', () => {
    const TOOK_TOO_LONG =
      "Plugin 'acme-games' took too long to start its DataGateway driver: the server waited 30 seconds. " +
      'Check that its upstream can be reached, or report this to the plugin author.';

    /** Lets the promises that are ready run, without moving the clock. */
    const flush = () => jest.advanceTimersByTimeAsync(0);

    /** How a build ended: `built`, or what it rejected with. Taken at once, so a late rejection is never unhandled. */
    const outcomeOf = (building: Promise<unknown>): Promise<unknown> =>
      building.then(
        () => 'built',
        (err: unknown) => err,
      );

    beforeEach(() => {
      jest.useFakeTimers();
    });

    // In this order: a spy on the fake clock's setTimeout, restored after
    // the real one is back, would put the stopped clock's in its place.
    afterEach(() => {
      jest.restoreAllMocks();
      jest.useRealTimers();
    });

    it('fails the build once half a minute has passed, saying which plugin was slow, when the driver factory never settles (#1083)', async () => {
      load(() => new Promise(() => undefined));
      const outcome = outcomeOf(source.build(GW, routedPlugin()));

      await jest.advanceTimersByTimeAsync(29_999);
      await expect(Promise.race([outcome, 'still building'])).resolves.toBe('still building');

      await jest.advanceTimersByTimeAsync(1);
      const failure = await outcome;

      expect(PLUGIN_DRIVER_BUILD_TIMEOUT_MS).toBe(30_000);
      expect(failure).toBeInstanceOf(PluginDataGatewayBuildTimeoutError);
      expect(failure).toMatchObject({ slug: SLUG, message: TOOK_TOO_LONG });
      expect(jest.getTimerCount()).toBe(0);
    });

    // The registry was told the build failed, and holds no driver. One that
    // turns up afterwards would keep its handles and timers for ever.
    it('disposes of a driver that arrives after the build failed, as the plugin, and never hands it out (#1083)', async () => {
      const late = deferred<DataGatewayDriver>();
      const pluginDriver = new InMemoryGatewayDriver();
      const disposedAs: Array<Actor | null> = [];
      jest.spyOn(pluginDriver, 'dispose').mockImplementation(() => {
        disposedAs.push(audit.getActor());
      });
      load(() => late.promise);
      const outcome = outcomeOf(triggered(() => source.build(GW, routedPlugin())));
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toBeInstanceOf(PluginDataGatewayBuildTimeoutError);
      expect(disposedAs).toEqual([]);

      late.resolve(pluginDriver);
      await flush();

      expect(disposedAs).toEqual([THE_PLUGIN_TRIGGERED]);
    });

    it('logs a driver factory that fails after the build did, and raises nothing more (#1083)', async () => {
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const late = deferred<DataGatewayDriver>();
      load(() => late.promise);
      const outcome = outcomeOf(source.build(GW, routedPlugin()));
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toBeInstanceOf(PluginDataGatewayBuildTimeoutError);

      late.reject(new Error('The token endpoint never answered'));
      await flush();

      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned).toHaveBeenCalledWith(
        "Plugin 'acme-games' failed to start its DataGateway driver, after the server had stopped waiting for it: " +
          'The token endpoint never answered',
      );
    });

    // The bound's timer is the only thing a build leaves running. It goes
    // when the driver factory settles, either way, and while it runs it
    // doesn't keep the process from exiting.
    it('keeps one timer while the driver factory is at work, which does not hold the process open, and none once it settles (#1083)', async () => {
      const timers = jest.spyOn(globalThis, 'setTimeout');
      const starting = deferred<DataGatewayDriver>();
      load(() => starting.promise);
      const outcome = outcomeOf(source.build(GW, routedPlugin()));
      await flush();

      expect(jest.getTimerCount()).toBe(1);
      expect(timers.mock.results.map((set) => (set.value as NodeJS.Timeout).hasRef())).toEqual([false]);

      starting.resolve(new InMemoryGatewayDriver());
      await expect(outcome).resolves.toBe('built');
      expect(jest.getTimerCount()).toBe(0);

      plugins.clear();
      load(() => Promise.reject(new Error('The upstream key is missing')));
      await expect(source.build(GW, routedPlugin())).rejects.toThrow('The upstream key is missing');
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  // A product that is no driver is never handed to the gateway registry. If
  // it can be disposed of, it may hold handles and timers all the same, and
  // each failed build until auto-disable would leave one more behind.
  describe('a product that is no driver but has a dispose', () => {
    afterEach(() => jest.restoreAllMocks());

    it('is disposed of as the plugin before the build fails (#1083)', async () => {
      const disposedAs: Array<Actor | null> = [];
      const dispose = jest.fn(() => {
        disposedAs.push(audit.getActor());
      });
      const notADriver = { ...driverShape(), listMechanics: undefined, dispose };
      load(() => notADriver);

      await expect(triggered(() => source.build(GW, routedPlugin()))).rejects.toBeInstanceOf(
        PluginDataGatewayBuildError,
      );

      expect(disposedAs).toEqual([THE_PLUGIN_TRIGGERED]);
      expect(dispose.mock.contexts[0]).toBe(notADriver);
    });

    // Best effort: the build has failed whatever the dispose does, and must
    // settle, so it waits for none of it.
    it('fails the build all the same when that dispose throws, logging it, or never settles (#1083)', async () => {
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      load(() => ({
        ...driverShape(),
        listMechanics: undefined,
        dispose: () => {
          throw new Error('The connection pool was never opened');
        },
      }));

      await expect(source.build(GW, routedPlugin())).rejects.toBeInstanceOf(PluginDataGatewayBuildError);
      await settle();

      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned).toHaveBeenCalledWith(
        "Failed to dispose of what plugin 'acme-games' handed over, which the server did not use: " +
          'The connection pool was never opened',
      );

      plugins.clear();
      load(() => ({ ...driverShape(), listMechanics: undefined, dispose: () => new Promise(() => undefined) }));

      await expect(source.build(GW, routedPlugin())).rejects.toBeInstanceOf(PluginDataGatewayBuildError);
    });
  });

  // A plugin acts with the authority consented to it, never with that of
  // whoever set it running. So every part of the plugin's code the server
  // runs, it runs as the plugin actor, and the actor whose work reached the
  // plugin is recorded as the trigger alone.
  describe("the plugin's actor scope", () => {
    it("builds through the plugin's driver factory, inside the plugin's actor scope as its Server-scope self (#1083)", async () => {
      const seen: Record<string, Actor | null> = {};
      const pluginDriver = new InMemoryGatewayDriver();
      jest.spyOn(pluginDriver, 'ping').mockImplementation(() => {
        seen.operationCalled = audit.getActor();

        return defer(async () => {
          seen.operationSubscribed = audit.getActor();
          await settle();
          seen.operationAfterWaiting = audit.getActor();

          return PONG;
        });
      });
      load(async () => {
        seen.factory = audit.getActor();
        await settle();
        seen.factoryAfterWaiting = audit.getActor();

        return pluginDriver;
      });

      const driver = await triggered(() => source.build(GW, routedPlugin()));
      await triggered(() => firstValueFrom(driver.ping({ correlationId: 'c' })));

      expect(seen).toEqual({
        factory: THE_PLUGIN_TRIGGERED,
        factoryAfterWaiting: THE_PLUGIN_TRIGGERED,
        operationCalled: THE_PLUGIN_TRIGGERED,
        operationSubscribed: THE_PLUGIN_TRIGGERED,
        operationAfterWaiting: THE_PLUGIN_TRIGGERED,
      });
    });

    // The gateway registry disposes a driver from whatever work drops it: a
    // user's request whose routing decision finds the plugin gone, a config
    // event, shutdown.
    it("runs the plugin's dispose in the plugin's actor scope, as the driver's own method (#1083)", async () => {
      const seen: Record<string, Actor | null> = {};
      const pluginDriver = new InMemoryGatewayDriver();
      const disposed = jest.spyOn(pluginDriver, 'dispose').mockImplementation(async () => {
        seen.dispose = audit.getActor();
        await settle();
        seen.disposeAfterWaiting = audit.getActor();
      });
      load(() => pluginDriver);
      const driver = await source.build(GW, routedPlugin());

      await triggered(() => driver.dispose());

      expect(seen).toEqual({ dispose: THE_PLUGIN_TRIGGERED, disposeAfterWaiting: THE_PLUGIN_TRIGGERED });
      expect(disposed).toHaveBeenCalledTimes(1);
      expect(disposed.mock.contexts[0]).toBe(pluginDriver);
    });

    it("runs the plugin's handleInbound in the plugin's actor scope, with the event it was given (#1083)", async () => {
      const seen: Record<string, Actor | null> = {};
      const handleInbound = jest.fn(async () => {
        seen.handleInbound = audit.getActor();
      });
      const pluginDriver = Object.assign(new InMemoryGatewayDriver(), { handleInbound });
      load(() => pluginDriver);
      const driver = await source.build(GW, routedPlugin());

      await triggered(() => driver.handleInbound?.(INBOUND));

      expect(seen).toEqual({ handleInbound: THE_PLUGIN_TRIGGERED });
      expect(handleInbound).toHaveBeenCalledWith(INBOUND);
      expect(handleInbound.mock.contexts[0]).toBe(pluginDriver);
    });

    it("has no handleInbound when the plugin's driver has none (#1083)", async () => {
      load(() => new InMemoryGatewayDriver());

      expect(await source.build(GW, routedPlugin())).not.toHaveProperty('handleInbound');
    });

    // What a client library hands back is often no Promise but a request
    // object: nothing happens until its `then` is called, and that call
    // starts the work. Its `then` is the plugin's code. So the server
    // resolves what the plugin returns inside the plugin's actor scope, and
    // never leaves it to whoever awaits the result, in their own scope.
    describe('a lazy thenable the plugin returns', () => {
      /** A thenable that does nothing until `then` is called, and notes the actor it is called as. */
      const lazyThenable = <T>(value: T, calledAs: Array<Actor | null>): PromiseLike<T> => ({
        then: (onFulfilled, onRejected) => {
          calledAs.push(audit.getActor());

          return Promise.resolve(value).then(onFulfilled, onRejected);
        },
      });

      it('is resolved as the plugin when the driver factory returns it (#1083)', async () => {
        const calledAs: Array<Actor | null> = [];
        load(() => lazyThenable(new InMemoryGatewayDriver({ gatewayName: 'Started lazily' }), calledAs));

        const driver = await triggered(() => source.build(GW, routedPlugin()));

        expect(calledAs).toEqual([THE_PLUGIN_TRIGGERED]);
        await expect(firstValueFrom(driver.ping({ correlationId: 'c' }))).resolves.toMatchObject({
          gatewayName: 'Started lazily',
        });
      });

      it('is resolved as the plugin when dispose returns it (#1083)', async () => {
        const calledAs: Array<Actor | null> = [];
        const pluginDriver = new InMemoryGatewayDriver();
        // The port lets dispose return a Promise; this plugin returns what its client library gave it.
        jest.spyOn(pluginDriver, 'dispose').mockImplementation((() => lazyThenable(undefined, calledAs)) as never);
        load(() => pluginDriver);
        const driver = await source.build(GW, routedPlugin());

        // Awaited inside the trigger's scope, as the gateway registry awaits a dispose.
        await triggered(async () => {
          await driver.dispose();
        });

        expect(calledAs).toEqual([THE_PLUGIN_TRIGGERED]);
      });

      it('is resolved as the plugin when handleInbound returns it (#1083)', async () => {
        const calledAs: Array<Actor | null> = [];
        const pluginDriver = Object.assign(new InMemoryGatewayDriver(), {
          handleInbound: (() => lazyThenable(undefined, calledAs)) as never,
        });
        load(() => pluginDriver);
        const driver = await source.build(GW, routedPlugin());

        await triggered(async () => {
          await driver.handleInbound?.(INBOUND);
        });

        expect(calledAs).toEqual([THE_PLUGIN_TRIGGERED]);
      });

      it('is resolved as the plugin when an operation answers with it (#1083)', async () => {
        const calledAs: Array<Actor | null> = [];
        const driver = await driverWhosePing(() => lazyThenable(PONG, calledAs));

        await expect(triggered(() => firstValueFrom(driver.ping({ correlationId: 'c' })))).resolves.toBe(PONG);

        expect(calledAs).toEqual([THE_PLUGIN_TRIGGERED]);
      });
    });

    // The interview backstop's timer, for one, reaches a driver with no actor
    // in scope. The plugin's trigger is then the system, and says what the
    // server was doing.
    it('names what the server was doing as the trigger when no actor is in scope (#1083)', async () => {
      const triggers: Record<string, unknown> = {};
      const note = (where: string) => {
        const actor = audit.getActor();
        triggers[where] = actor?.kind === 'plugin' ? actor.trigger : actor;
      };
      const pluginDriver = Object.assign(new InMemoryGatewayDriver(), {
        handleInbound: async () => note('inbound'),
      });
      jest.spyOn(pluginDriver, 'ping').mockImplementation(() => {
        note('call');

        return of(PONG);
      });
      jest.spyOn(pluginDriver, 'dispose').mockImplementation(() => note('dispose'));
      load(() => {
        note('build');

        return pluginDriver;
      });

      const driver = await source.build(GW, routedPlugin());
      await firstValueFrom(driver.ping({ correlationId: 'c' }));
      await driver.handleInbound?.(INBOUND);
      await driver.dispose();

      expect(triggers).toEqual({
        build: { kind: 'system', reason: 'plugin-data-gateway-build' },
        call: { kind: 'system', reason: 'plugin-data-gateway-call' },
        inbound: { kind: 'system', reason: 'plugin-data-gateway-inbound' },
        dispose: { kind: 'system', reason: 'plugin-data-gateway-dispose' },
      });
    });
  });

  // The plugin's actor scope ends where the server's code begins, in both
  // directions. The server works on a driver's answer in RxJS operators of
  // its own: the coordinator's search reads the database for each frame. That
  // code runs as whoever subscribed, never as the plugin. And when the server
  // stops listening, what tears the answer down is the plugin's code again,
  // so it runs as the plugin, never as whoever stopped listening.
  describe("where the plugin's actor scope ends", () => {
    const FAILURE = new Error('The upstream is down');

    /** An answer of one pong, or a failed one for a request whose correlation id is `fails`, emitted as the case says. */
    const ANSWERS: Record<string, (request: proto.GatewayPingRequest) => Observable<proto.GatewayPingResponse>> = {
      asynchronously: (request) =>
        defer(async () => {
          await settle();

          if (request.correlationId === 'fails') {
            throw FAILURE;
          }

          return PONG;
        }),
      synchronously: (request) => (request.correlationId === 'fails' ? throwError(() => FAILURE) : of(PONG)),
    };

    /** The actor the server's subscriber saw in each notification of `answer`, once the answer has ended. */
    const actorsTheServerSaw = (answer: Observable<unknown>): Promise<Record<string, Actor | null>> =>
      new Promise((resolve) => {
        const seen: Record<string, Actor | null> = {};

        answer.subscribe({
          next: () => {
            seen.next = audit.getActor();
          },
          error: () => {
            seen.error = audit.getActor();
            resolve(seen);
          },
          complete: () => {
            seen.complete = audit.getActor();
            resolve(seen);
          },
        });
      });

    it.each(Object.keys(ANSWERS))(
      "the server's subscriber sees its own actor in next, error and complete, for an answer the plugin emits %s (#1083)",
      async (when) => {
        const driver = await driverWhosePing(ANSWERS[when]);

        await expect(triggered(() => actorsTheServerSaw(driver.ping({ correlationId: 'c' })))).resolves.toEqual({
          next: TRIGGER,
          complete: TRIGGER,
        });
        await expect(triggered(() => actorsTheServerSaw(driver.ping({ correlationId: 'fails' })))).resolves.toEqual({
          error: TRIGGER,
        });
      },
    );

    // What the coordinator's search does with each frame of a driver's answer.
    it.each(Object.keys(ANSWERS))(
      "the server's RxJS operators after the answer, and the work they start, run as the server's actor, for an answer the plugin emits %s (#1083)",
      async (when) => {
        const driver = await driverWhosePing(ANSWERS[when]);

        const seen = await triggered(() =>
          lastValueFrom(
            driver.ping({ correlationId: 'c' }).pipe(
              concatMap(async () => {
                const inTheOperator = audit.getActor();
                await settle();

                return { inTheOperator, afterItsWait: audit.getActor() };
              }),
            ),
          ),
        );

        expect(seen).toEqual({ inTheOperator: TRIGGER, afterItsWait: TRIGGER });
      },
    );

    // The interview backstop's timer subscribes with no actor in scope.
    it.each(Object.keys(ANSWERS))(
      "with no actor in scope when the server subscribes, the server's subscriber sees none, for an answer the plugin emits %s (#1083)",
      async (when) => {
        const driver = await driverWhosePing(ANSWERS[when]);

        await expect(actorsTheServerSaw(driver.ping({ correlationId: 'c' }))).resolves.toEqual({
          next: null,
          complete: null,
        });
        await expect(actorsTheServerSaw(driver.ping({ correlationId: 'fails' }))).resolves.toEqual({ error: null });
      },
    );

    // A client that cancels its search is the trigger of the teardown, and
    // lends the plugin no authority for it.
    it("runs the plugin's teardown as the plugin actor, with whoever stopped listening as trigger, when the server unsubscribes early (#1083)", async () => {
      const tornDownAs: Array<Actor | null> = [];
      const driver = await driverWhosePing(
        () =>
          new Observable(() => () => {
            tornDownAs.push(audit.getActor());
          }),
      );
      const first = triggered(() => driver.ping({ correlationId: 'c' }).subscribe());
      const second = triggered(() => driver.ping({ correlationId: 'c' }).subscribe());

      system.run('a-client-cancels-its-search', () => first.unsubscribe());
      second.unsubscribe();

      expect(tornDownAs).toEqual([
        { ...THE_PLUGIN_TRIGGERED, trigger: { kind: 'system', reason: 'a-client-cancels-its-search' } },
        // With no actor in scope, the trigger names the call that is ending.
        { ...THE_PLUGIN_TRIGGERED, trigger: { kind: 'system', reason: 'plugin-data-gateway-call' } },
      ]);
    });

    // A plugin may emit from inside the subscribe call, before the server
    // holds anything to unsubscribe with. An RxJS operator of the server's
    // that has what it wants then still stops the plugin there, not at the
    // end of all it would emit.
    it("stops an answer the plugin emits synchronously once an RxJS operator of the server's stops listening inside next, and runs the plugin's teardown as the plugin (#1083)", async () => {
      let emitted = 0;
      const tornDownAs: Array<Actor | null> = [];
      const driver = await driverWhosePing(
        () =>
          new Observable<proto.GatewayPingResponse>((subscriber) => {
            while (!subscriber.closed && emitted < 3) {
              emitted += 1;
              subscriber.next(PONG);
            }

            return () => {
              tornDownAs.push(audit.getActor());
            };
          }),
      );

      await expect(triggered(() => lastValueFrom(driver.ping({ correlationId: 'c' }).pipe(take(1))))).resolves.toBe(
        PONG,
      );

      expect(emitted).toBe(1);
      expect(tornDownAs).toEqual([THE_PLUGIN_TRIGGERED]);
    });

    it("runs the plugin's teardown as the plugin when an RxJS operator of the server's stops listening inside next, for an answer the plugin emits asynchronously (#1083)", async () => {
      const tornDownAs: Array<Actor | null> = [];
      const driver = await driverWhosePing(
        () =>
          new Observable<proto.GatewayPingResponse>((subscriber) => {
            const emitting = setInterval(() => subscriber.next(PONG), 0);

            return () => {
              clearInterval(emitting);
              tornDownAs.push(audit.getActor());
            };
          }),
      );

      await expect(triggered(() => lastValueFrom(driver.ping({ correlationId: 'c' }).pipe(take(1))))).resolves.toBe(
        PONG,
      );

      expect(tornDownAs).toEqual([THE_PLUGIN_TRIGGERED]);
    });

    it('runs the teardown of an answer the plugin completes synchronously once, as the plugin (#1083)', async () => {
      const tornDownAs: Array<Actor | null> = [];
      const driver = await driverWhosePing(
        () =>
          new Observable<proto.GatewayPingResponse>((subscriber) => {
            subscriber.next(PONG);
            subscriber.complete();

            return () => {
              tornDownAs.push(audit.getActor());
            };
          }),
      );

      await expect(triggered(() => lastValueFrom(driver.ping({ correlationId: 'c' })))).resolves.toBe(PONG);

      expect(tornDownAs).toEqual([THE_PLUGIN_TRIGGERED]);
    });

    it('runs the teardown of an answer the plugin completes asynchronously once, as the plugin (#1083)', async () => {
      const tornDownAs: Array<Actor | null> = [];
      const driver = await driverWhosePing(
        () =>
          new Observable<proto.GatewayPingResponse>((subscriber) => {
            const answering = setTimeout(() => {
              subscriber.next(PONG);
              subscriber.complete();
            }, 0);

            return () => {
              clearTimeout(answering);
              tornDownAs.push(audit.getActor());
            };
          }),
      );

      await expect(triggered(() => lastValueFrom(driver.ping({ correlationId: 'c' })))).resolves.toBe(PONG);

      expect(tornDownAs).toEqual([THE_PLUGIN_TRIGGERED]);
    });

    // The failure is the server's own, raised in its own code: it reaches the
    // server's subscriber as the server's actor, and ends the plugin's answer
    // as any stop does.
    it.each<[string, (teardown: () => void) => Observable<proto.GatewayPingResponse>]>([
      [
        'asynchronously',
        (teardown) =>
          new Observable((subscriber) => {
            const emitting = setInterval(() => subscriber.next(PONG), 0);

            return () => {
              clearInterval(emitting);
              teardown();
            };
          }),
      ],
      [
        'synchronously',
        (teardown) =>
          new Observable((subscriber) => {
            subscriber.next(PONG);

            return teardown;
          }),
      ],
    ])(
      "an RxJS operator of the server's that throws inside next fails the answer as the server's actor, and the plugin's teardown runs once as the plugin, for an answer the plugin emits %s (#1083)",
      async (_when, answering) => {
        const tornDownAs: Array<Actor | null> = [];
        const driver = await driverWhosePing(() => answering(() => tornDownAs.push(audit.getActor())));
        const thrown = new Error("The server's own code failed on a frame");

        const seen = await triggered(() =>
          actorsTheServerSaw(
            driver.ping({ correlationId: 'c' }).pipe(
              map(() => {
                throw thrown;
              }),
            ),
          ),
        );

        expect(seen).toEqual({ error: TRIGGER });
        expect(tornDownAs).toEqual([THE_PLUGIN_TRIGGERED]);
      },
    );

    it("an operation that throws fails the answer as the server's actor, or as none when the server subscribed with none in scope (#1083)", async () => {
      const driver = await driverWhosePing(() => {
        throw FAILURE;
      });

      await expect(triggered(() => actorsTheServerSaw(driver.ping({ correlationId: 'c' })))).resolves.toEqual({
        error: TRIGGER,
      });
      await expect(actorsTheServerSaw(driver.ping({ correlationId: 'c' }))).resolves.toEqual({ error: null });
    });
  });

  // A plugin is someone else's package. It may carry its own copy of RxJS,
  // answer with a Promise, or throw where it should answer. Whatever it does,
  // the server's code is handed the server's Observable, and a failure
  // arrives as that Observable's error.
  describe("what the plugin's operation answers with", () => {
    it("hands on an answer from the plugin's own copy of RxJS as the server's Observable (#1083)", async () => {
      const pluginsRxjs = anotherCopyOfRxjs();
      const pluginsAnswer = pluginsRxjs.of(PONG);
      const driver = await driverWhosePing(() => pluginsAnswer);

      const answer = driver.ping({ correlationId: 'c' });

      // To the server's RxJS, the plugin's Observable is no Observable at all.
      expect(pluginsAnswer).not.toBeInstanceOf(Observable);
      expect(answer).toBeInstanceOf(Observable);
      await expect(lastValueFrom(answer.pipe(toArray()))).resolves.toEqual([PONG]);
    });

    it('takes a Promise for an answer (#1083)', async () => {
      const driver = await driverWhosePing(() => Promise.resolve(PONG));

      await expect(lastValueFrom(driver.ping({ correlationId: 'c' }).pipe(toArray()))).resolves.toEqual([PONG]);
    });

    it("sends on the error of the plugin's answer (#1083)", async () => {
      const failure = new Error('The upstream is down');
      const driver = await driverWhosePing(() => throwError(() => failure));

      await expect(firstValueFrom(driver.ping({ correlationId: 'c' }))).rejects.toBe(failure);
    });

    it('sends a throw from the operation as an error of the answer, never as a throw of its own (#1083)', async () => {
      const failure = new Error('The plugin threw where it should answer');
      const driver = await driverWhosePing(() => {
        throw failure;
      });

      const answer = driver.ping({ correlationId: 'c' });

      await expect(firstValueFrom(answer)).rejects.toBe(failure);
    });

    it('sends an answer that is no stream as an error of the answer (#1083)', async () => {
      const driver = await driverWhosePing(() => undefined);

      const answer = driver.ping({ correlationId: 'c' });

      expect(answer).toBeInstanceOf(Observable);
      await expect(firstValueFrom(answer)).rejects.toBeInstanceOf(TypeError);
    });

    // A search the user abandons is unsubscribed, and the plugin must hear
    // of it to stop its own work.
    it("stops the plugin's stream when the server stops listening (#1083)", async () => {
      const stopped = jest.fn();
      const driver = await driverWhosePing(() => new Observable(() => stopped));

      const listening = driver.ping({ correlationId: 'c' }).subscribe();
      expect(stopped).not.toHaveBeenCalled();
      listening.unsubscribe();

      expect(stopped).toHaveBeenCalledTimes(1);
    });
  });
});
