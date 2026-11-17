import type { Actor } from '@bge/actor-context';
import { AuditContextService, SystemActorScope } from '@bge/actor-context';
import { AuthType, DatabaseService, PluginCategory } from '@bge/database';
import type { PluginLoadRecordRow } from '@bge/database/testing';
import { fakePluginLoadRecords } from '@bge/database/testing';
import type { PluginDriverSource, RoutedPlugin } from '@bge/gateway-registry';
import { PLUGIN_DRIVER_SOURCE, RemoteGatewayDriverFactory } from '@bge/gateway-registry';
import { BGE_ACTOR_HEADER, BGE_GATEWAY_ID_HEADER } from '@bge/shared';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { DATA_GATEWAY_DRIVER_OPERATIONS } from '@boardgamesempire/gateway-driver-contract';
import type * as proto from '@boardgamesempire/proto-gateway';
import type { InterceptingCall, Interceptor, InterceptorOptions, NextCall } from '@grpc/grpc-js';
import { Metadata, status } from '@grpc/grpc-js';
import type { DynamicModule } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { setTimeout as delay } from 'node:timers/promises';
import { defer, firstValueFrom, of } from 'rxjs';
import { PluginGatewayRelayModule } from './plugin-gateway-relay.module';
import { PluginGatewayRelaySource } from './plugin-gateway-relay.source';

/** The plugin DataGateway a driver is built for. */
const GW = 'acme';

const SLUG = 'acme-games';
const INSTALLED_AT = new Date('2026-11-01T00:00:00Z');

/**
 * The actor whose work reaches the DataGateway, as a queued job's is. A spec
 * outside the entry points can put only a system actor in scope, so the job
 * is the server's own here.
 */
const THE_JOB: Actor = { kind: 'system', reason: 'a-job-searches-the-data-gateway' };

/** The actor the coordinator must see on a call that nobody's work made. */
const THE_RELAY: Actor = { kind: 'system', reason: 'plugin-gateway-relay' };

const PONG = { correlationId: 'c', gatewayName: 'Acme Games' } as proto.GatewayPingResponse;

/** What the stand-in for the gateway registry's module was given when it asked for the plugin driver source. */
const HANDED_TO_THE_REGISTRY = Symbol('HANDED_TO_THE_REGISTRY');

/** The plugin as a routing decision reads it from its row. */
const routedPlugin = (overrides: Partial<RoutedPlugin> = {}): RoutedPlugin => ({
  id: 'plugin-1',
  slug: SLUG,
  category: PluginCategory.DataGateway,
  enabled: true,
  uninstalledAt: null,
  loadFailed: false,
  installedAt: INSTALLED_AT,
  ...overrides,
});

/** A driver as the factory hands one out, with every method a mock. */
const relayDriver = (): jest.Mocked<DataGatewayDriver> =>
  Object.fromEntries(
    [...DATA_GATEWAY_DRIVER_OPERATIONS, 'dispose'].map((method) => [method, jest.fn()]),
  ) as unknown as jest.Mocked<DataGatewayDriver>;

/**
 * The metadata a call goes out with once `interceptors` have run on it,
 * chained as grpc-js chains a client's: the first is outermost.
 */
const metadataSentThrough = (interceptors: Interceptor[]): Metadata => {
  let sent: Metadata | undefined;
  const wire = {
    start: (metadata: Metadata) => {
      sent = metadata;
    },
  } as unknown as InterceptingCall;
  const outermost = interceptors.reduceRight<NextCall>(
    (next, interceptor) => (options) => interceptor(options, next),
    () => wire,
  );

  outermost({} as InterceptorOptions).start(new Metadata(), {});

  if (!sent) {
    throw new Error('An interceptor did not pass the call on');
  }

  return sent;
};

/** The actor a call's metadata names, as the coordinator decodes it. */
const actorIn = (metadata: Metadata): Actor =>
  JSON.parse(Buffer.from(String(metadata.get(BGE_ACTOR_HEADER)[0]), 'base64').toString('utf8')) as Actor;

/** A load record a process wrote for the install, ready and with a heartbeat just now. */
const loadRecord = (overrides: Partial<PluginLoadRecordRow> = {}): PluginLoadRecordRow => ({
  slug: SLUG,
  processRole: 'coordinator',
  installedAt: INSTALLED_AT,
  ready: true,
  heartbeatAt: new Date(),
  ...overrides,
});

/**
 * The gateway worker's plugin driver source: the gateway worker loads no
 * plugin, so it answers the gateway registry from the coordinator's plugin
 * load records, and its drivers call the coordinator (#1083).
 */
describe('PluginGatewayRelaySource', () => {
  const originalEnvironment = process.env;

  let source: PluginDriverSource;
  let audit: AuditContextService;
  let system: SystemActorScope;
  let factory: { create: jest.Mock };

  /** The modules a test compiled, one or two, for the teardown to close. */
  const compiled: TestingModule[] = [];

  // A table that answers the lookup's filter, so the specs assert what a
  // record means and not the query's shape.
  const loads = fakePluginLoadRecords();
  const findFirst = jest.fn(loads.findFirst);

  /**
   * Stands in for the gateway registry's module, which a process that mounts
   * the relay's module mounts too. Like it, this one exports the factory the
   * source dials with to every module, and asks for the plugin driver source
   * without importing the module that provides it.
   */
  const gatewayRegistryStandIn = (): DynamicModule => ({
    module: class GatewayRegistryStandIn {},
    global: true,
    providers: [
      { provide: RemoteGatewayDriverFactory, useValue: factory },
      {
        provide: HANDED_TO_THE_REGISTRY,
        useFactory: (pluginDrivers: PluginDriverSource) => pluginDrivers,
        inject: [PLUGIN_DRIVER_SOURCE],
      },
    ],
    exports: [RemoteGatewayDriverFactory],
  });

  /**
   * A process that mounts the relay's module, whose environment puts the
   * coordinator at `coordinator.internal:50077`, or where `environment` says.
   */
  const processIn = async (environment: NodeJS.ProcessEnv = {}): Promise<TestingModule> => {
    process.env = {
      ...originalEnvironment,
      GATEWAY_COORDINATOR_HOST: 'coordinator.internal',
      GATEWAY_COORDINATOR_PORT: '50077',
      ...environment,
    };

    const module = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        gatewayRegistryStandIn(),
        PluginGatewayRelayModule,
      ],
    })
      .overrideProvider(DatabaseService)
      .useValue({ pluginProcessLoad: { findFirst } })
      .compile();

    compiled.push(module);

    return module;
  };

  /** The source as that process's gateway registry is handed it. */
  const sourceIn = async (environment: NodeJS.ProcessEnv = {}): Promise<PluginDriverSource> => {
    const module = await processIn(environment);

    audit = module.get(AuditContextService, { strict: false });
    system = module.get(SystemActorScope, { strict: false });

    return module.get<PluginDriverSource>(HANDED_TO_THE_REGISTRY, { strict: false });
  };

  /** Runs `work` with the job's actor in scope, as the queue's consumer runs a job. */
  const asTheJob = <T>(work: () => T): T => system.run(THE_JOB.reason, work);

  /** A driver whose ping notes in `seen` the actor in scope when it is called and when it is subscribed. */
  const notingDriver = (seen: Record<string, Actor | null>): jest.Mocked<DataGatewayDriver> => {
    const driver = relayDriver();
    driver.ping.mockImplementation(() => {
      seen.called = audit.getActor();

      return defer(() => {
        seen.subscribed = audit.getActor();

        return of(PONG);
      });
    });

    return driver;
  };

  beforeEach(async () => {
    loads.rows = [];
    findFirst.mockClear();
    factory = { create: jest.fn() };
    source = await sourceIn();
  });

  afterEach(async () => {
    process.env = originalEnvironment;
    await Promise.all(compiled.splice(0).map((module) => module.close()));
  });

  describe('PluginGatewayRelayModule', () => {
    it('hands the gateway registry the one source it provides, as its plugin driver source (#1083)', async () => {
      const module = await processIn();

      const handed = module.get<PluginDriverSource>(HANDED_TO_THE_REGISTRY, { strict: false });

      expect(handed).toBeInstanceOf(PluginGatewayRelaySource);
      expect(handed).toBe(module.get(PluginGatewayRelaySource, { strict: false }));
    });
  });

  describe('isLoaded', () => {
    it('is loaded while a live load record of the coordinator names the install (#1083)', async () => {
      loads.rows = [loadRecord()];

      await expect(source.isLoaded(routedPlugin())).resolves.toBe(true);
    });

    // An update can move a plugin into the data-gateway category without a
    // reinstall. Until the api restarts, its record names the same install,
    // though the coordinator, which this source dials, has not loaded it.
    it("is not loaded when only the api's record names it (#1083)", async () => {
      loads.rows = [loadRecord({ processRole: 'api' })];

      await expect(source.isLoaded(routedPlugin())).resolves.toBe(false);
    });

    // Asked twice, so an answer kept from the first ask would fail: the
    // gateway registry must refuse the DataGateway once the coordinator is
    // gone, and not dial an address nothing answers at.
    it("is not loaded after the coordinator's clean shutdown removed its records (#1083)", async () => {
      loads.rows = [loadRecord()];
      await expect(source.isLoaded(routedPlugin())).resolves.toBe(true);

      loads.rows = [];

      await expect(source.isLoaded(routedPlugin())).resolves.toBe(false);
    });

    // The gateway registry reads a rejection as not loaded for the one
    // decision that asked, and logs it. Answering false here instead would
    // have it drop a driver that may still be good.
    it("rejects when the load records can't be read (#1083)", async () => {
      findFirst.mockRejectedValueOnce(new Error('The database connection was lost'));

      await expect(source.isLoaded(routedPlugin())).rejects.toThrow('The database connection was lost');
    });
  });

  describe('build', () => {
    it("builds a driver at the coordinator's address that names the DataGateway and carries the actor (#1083)", async () => {
      factory.create.mockResolvedValue(relayDriver());

      await source.build(GW, routedPlugin());

      expect(factory.create).toHaveBeenCalledTimes(1);
      const [options, channel] = factory.create.mock.calls[0] as Parameters<RemoteGatewayDriverFactory['create']>;
      expect(options).toEqual({
        gatewayId: GW,
        connectionUrl: 'coordinator.internal',
        connectionPort: 50077,
        authType: AuthType.None,
      });
      expect(channel?.interceptors).toHaveLength(2);

      const sent = asTheJob(() => metadataSentThrough(channel?.interceptors ?? []));
      expect(sent.get(BGE_GATEWAY_ID_HEADER)).toEqual([GW]);
      expect(actorIn(sent)).toEqual(THE_JOB);
    });

    // The factory joins the address to the port as written, and gRPC finds no
    // port in an IPv6 address that isn't bracketed.
    it("brackets the coordinator's address when it is an IPv6 one (#1083)", async () => {
      source = await sourceIn({ GATEWAY_COORDINATOR_HOST: '::1' });
      factory.create.mockResolvedValue(relayDriver());

      await source.build(GW, routedPlugin());

      expect(factory.create.mock.calls[0][0]).toMatchObject({ connectionUrl: '[::1]', connectionPort: 50077 });
    });

    // Uncaught, so the gateway registry counts it as a failed connect, as it
    // does for a remote DataGateway that is down.
    it("fails the build with the factory's error when the coordinator doesn't answer (#1083)", async () => {
      factory.create.mockRejectedValue(new Error('14 UNAVAILABLE: No connection established'));

      await expect(source.build(GW, routedPlugin())).rejects.toThrow('14 UNAVAILABLE: No connection established');
    });

    // A ping the coordinator answered with an error went through its routing
    // decision, or through a build of the plugin's driver it already counted:
    // asking again would make it build and count again.
    describe('the connect ping tries again only while the coordinator cannot be reached (#1083)', () => {
      /** The rule the source hands the factory for whether a failed connect ping is tried again. */
      const pingRetryRule = async (): Promise<(error: unknown) => boolean> => {
        factory.create.mockResolvedValue(relayDriver());
        await source.build(GW, routedPlugin());

        const [, channel] = factory.create.mock.calls[0] as Parameters<RemoteGatewayDriverFactory['create']>;
        const rule = channel?.shouldRetryPing;

        if (!rule) {
          throw new Error('The source handed the factory no ping retry rule');
        }

        return rule;
      };

      /** An error as a gRPC client reports a call that ended with `code`. */
      const grpcError = (code: status): Error => Object.assign(new Error(`${code} ${status[code]}`), { code });

      it('tries again when the coordinator is unavailable (#1083)', async () => {
        const rule = await pingRetryRule();

        expect(rule(grpcError(status.UNAVAILABLE))).toBe(true);
      });

      it.each(['FAILED_PRECONDITION', 'NOT_FOUND', 'UNKNOWN'] as const)(
        'does not try again when the coordinator answered %s (#1083)',
        async (code) => {
          const rule = await pingRetryRule();

          expect(rule(grpcError(status[code]))).toBe(false);
        },
      );
    });

    // The gateway registry disposes a driver it drops, and the gRPC channel
    // to the coordinator is the factory's driver's to close.
    it('disposing the driver disposes the one the factory built (#1083)', async () => {
      const built = relayDriver();
      factory.create.mockResolvedValue(built);
      const driver = await source.build(GW, routedPlugin());

      await driver.dispose();

      expect(built.dispose).toHaveBeenCalledTimes(1);
    });
  });

  // The coordinator refuses a call that carries no actor. Most calls the
  // gateway worker routes are made by a job, inside its actor scope, and go
  // out as that actor. The interview's hourly backstop makes its calls from a
  // timer, with no actor in scope.
  describe('the actor a call goes out as', () => {
    // Built for a job: the actor a build ran as doesn't decide for a later call.
    it('runs a call made outside any actor scope as the system (#1083)', async () => {
      const seen: Record<string, Actor | null> = {};
      factory.create.mockResolvedValue(notingDriver(seen));
      const driver = await asTheJob(() => source.build(GW, routedPlugin()));

      await firstValueFrom(driver.ping({ correlationId: 'c' }));

      expect(seen).toEqual({ called: THE_RELAY, subscribed: THE_RELAY });
    });

    // Built with no actor in scope: a build that ran as the system actor
    // doesn't decide for a later call either.
    it('leaves a call made inside an actor scope to that actor (#1083)', async () => {
      const seen: Record<string, Actor | null> = {};
      factory.create.mockResolvedValue(notingDriver(seen));
      const driver = await source.build(GW, routedPlugin());

      await asTheJob(() => firstValueFrom(driver.ping({ correlationId: 'c' })));

      expect(seen).toEqual({ called: THE_JOB, subscribed: THE_JOB });
    });

    // A gRPC call goes out when it is subscribed, and its metadata is written
    // from the actor in scope then.
    it('decides by the actor in scope when a call is subscribed, not when its operation was called (#1083)', async () => {
      const seen: Record<string, Actor | null> = {};
      const built = notingDriver(seen);
      factory.create.mockResolvedValue(built);
      const driver = await source.build(GW, routedPlugin());

      const calledByTheJob = asTheJob(() => driver.ping({ correlationId: 'c' }));
      expect(built.ping).not.toHaveBeenCalled();
      await firstValueFrom(calledByTheJob);

      expect(seen).toEqual({ called: THE_RELAY, subscribed: THE_RELAY });

      const calledByNobody = driver.ping({ correlationId: 'c' });
      await asTheJob(() => firstValueFrom(calledByNobody));

      expect(seen).toEqual({ called: THE_JOB, subscribed: THE_JOB });
    });
  });

  // The factory pings the coordinator before it hands the driver out, through
  // the same client, so the ping needs an actor as any call does. It waits
  // between tries, which the scope must last through.
  describe('the actor the connect ping goes out as', () => {
    /** A factory that notes in `seen` the actor in scope when it is asked, and after it has waited as a retried ping does. */
    const notingFactory = (seen: Record<string, Actor | null>) => async (): Promise<DataGatewayDriver> => {
      seen.asked = audit.getActor();
      await delay(0);
      seen.afterWaiting = audit.getActor();

      return relayDriver();
    };

    it('dials the coordinator as the system actor when the build is asked for outside any actor scope (#1083)', async () => {
      const seen: Record<string, Actor | null> = {};
      factory.create.mockImplementation(notingFactory(seen));

      await source.build(GW, routedPlugin());

      expect(seen).toEqual({ asked: THE_RELAY, afterWaiting: THE_RELAY });
    });

    it('dials the coordinator as the actor whose work asked for the build (#1083)', async () => {
      const seen: Record<string, Actor | null> = {};
      factory.create.mockImplementation(notingFactory(seen));

      await asTheJob(() => source.build(GW, routedPlugin()));

      expect(seen).toEqual({ asked: THE_JOB, afterWaiting: THE_JOB });
    });
  });
});
