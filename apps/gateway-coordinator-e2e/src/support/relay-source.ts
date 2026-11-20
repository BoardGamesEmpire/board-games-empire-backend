import { SystemActorScope } from '@bge/actor-context';
import { PluginGatewayRelayModule, PluginGatewayRelaySource } from '@bge/coordinator';
import type { PrismaClient } from '@bge/database';
import type { RoutedPlugin } from '@bge/gateway-registry';
import { GatewayCredentialsFactory, RemoteGatewayDriverFactory, ROUTED_PLUGIN_FIELDS } from '@bge/gateway-registry';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { afterAll, beforeAll } from '@jest/globals';
import type { DynamicModule } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import type { RunningCoordinator } from './coordinator';
import { COORDINATOR_PROTO_DIR } from './coordinator';

/**
 * The gateway worker's plugin driver source, `PluginGatewayRelaySource`, run
 * in the test process against the launched coordinator and the harness's
 * database (#1083). The gateway worker loads no plugin: its gateway registry
 * asks this source whether the coordinator has a plugin loaded, and gets from
 * it a driver that is a gRPC client of the coordinator. Running the source
 * here puts both of those on a real wire and a real table, without the queues
 * a whole gateway worker would need.
 */

/**
 * The driver factory the source dials with, reading the gateway protos from
 * the coordinator's bundle. The factory looks for them beside the bundle it
 * was compiled into, and the test process is no bundle.
 */
class CoordinatorProtoDriverFactory extends RemoteGatewayDriverFactory {
  protected override protoDirectory(): string {
    return COORDINATOR_PROTO_DIR;
  }
}

/**
 * Stands in for the gateway registry's module, which a gateway worker mounts
 * beside the relay's: like it, this exports the driver factory to every
 * module. The registry itself, with its Redis and its queues, isn't part of
 * what the source is.
 */
const gatewayRegistryStandIn: DynamicModule = {
  module: class GatewayRegistryStandIn {},
  global: true,
  providers: [
    GatewayCredentialsFactory,
    {
      provide: RemoteGatewayDriverFactory,
      useFactory: (credentials: GatewayCredentialsFactory) => new CoordinatorProtoDriverFactory(credentials),
      inject: [GatewayCredentialsFactory],
    },
  ],
  exports: [RemoteGatewayDriverFactory],
};

/** The variables the relay's module reads the coordinator's address from. */
const ADDRESS_VARIABLES = ['GATEWAY_COORDINATOR_HOST', 'GATEWAY_COORDINATOR_PORT'] as const;

export interface RelaySource {
  /**
   * Runs `work` with an actor in scope, as the queue's consumer runs a job.
   * Outside the server's entry points only a system actor can be put in
   * scope, so the job is the server's own, and `reason` names it.
   */
  asJob<T>(reason: string, work: () => T): T;

  /** A driver for the plugin DataGateway, whose calls go to the coordinator. It is disposed when the spec file ends. */
  build(gatewayId: string): Promise<DataGatewayDriver>;

  /** Whether a running coordinator has this install of the plugin loaded, as its plugin load records say. */
  isLoaded(plugin: RoutedPlugin): Promise<boolean>;
}

/** The plugin as a routing decision reads it from its row now. */
export function readRoutedPlugin(db: PrismaClient, pluginId: string): Promise<RoutedPlugin> {
  return db.plugin.findUniqueOrThrow({ where: { id: pluginId }, select: ROUTED_PLUGIN_FIELDS });
}

/**
 * Runs the source for the spec file that calls it, built in `beforeAll`
 * against the coordinator `useCoordinator` launched, so it is called after
 * `useCoordinator`. The returned function hands the source out.
 */
export function useRelaySource(coordinator: () => RunningCoordinator): () => RelaySource {
  let module: TestingModule | undefined;
  let relay: RelaySource | undefined;
  const built: DataGatewayDriver[] = [];

  beforeAll(async () => {
    const { host, port } = coordinator();
    const inherited = ADDRESS_VARIABLES.map((name) => [name, process.env[name]] as const);

    // The relay's module reads the address as it compiles, and keeps it.
    process.env['GATEWAY_COORDINATOR_HOST'] = host;
    process.env['GATEWAY_COORDINATOR_PORT'] = String(port);

    try {
      module = await Test.createTestingModule({
        imports: [
          ClsModule.forRoot({ global: true, middleware: { mount: false } }),
          gatewayRegistryStandIn,
          PluginGatewayRelayModule,
        ],
      }).compile();
    } finally {
      for (const [name, value] of inherited) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }

    const source = module.get(PluginGatewayRelaySource, { strict: false });
    const system = module.get(SystemActorScope, { strict: false });

    relay = {
      isLoaded: (plugin) => source.isLoaded(plugin),
      build: async (gatewayId) => {
        const driver = await source.build(gatewayId);
        built.push(driver);

        return driver;
      },
      asJob: (reason, work) => system.run(reason, work),
    };
  });

  afterAll(async () => {
    relay = undefined;
    await Promise.allSettled(built.splice(0).map((driver) => driver.dispose()));

    // Ends the source's database pool, which would keep Jest's event loop alive.
    await module?.close();
  });

  return () => {
    if (relay === undefined) {
      throw new Error(
        "The gateway worker's plugin driver source is not built: useRelaySource() builds it in beforeAll",
      );
    }

    return relay;
  };
}
