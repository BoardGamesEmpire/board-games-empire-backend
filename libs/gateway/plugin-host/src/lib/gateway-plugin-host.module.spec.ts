import type { Actor } from '@bge/actor-context';
import { AuditContextModule, AuditContextService, SystemActorScope } from '@bge/actor-context';
import { DatabaseService, DataGatewayCapability, PluginCategory } from '@bge/database';
import type { PluginDriverSource, RoutedPlugin } from '@bge/gateway-registry';
import {
  GatewayConfigEventsService,
  GatewayInterviewService,
  GatewayRegistryService,
  GatewayRoutingRefusedError,
  PLUGIN_DRIVER_SOURCE,
  RemoteGatewayDriverFactory,
} from '@bge/gateway-registry';
import type { LoadedPlugin } from '@bge/plugin';
import { PluginInstanceRegistry } from '@bge/plugin';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import { Global, Logger, Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { GatewayPluginHostModule } from './gateway-plugin-host.module';
import { PluginDataGatewaySource } from './plugin-data-gateway.source';
import { PluginGatewayController } from './plugin-gateway.controller';

const { Search } = DataGatewayCapability;

/** The plugin DataGateway the specs route. */
const GW = 'acme';

const SLUG = 'acme-games';
const PLUGIN_ID = 'plugin-1';
const INSTALLED_AT = '2026-11-01T00:00:00Z';

/** The plugin's row, with what an update's activation rewrites beside what a routing decision reads. */
interface PluginRow extends RoutedPlugin {
  installedSha256: string;
  restartRequired: boolean;
  version: string;
}

/**
 * What the coordinator mounts globally beside the plugin host module, and
 * the module itself never imports: the gateway registry, which is the real
 * one here, and the plugin runtime's registry of the plugins this process
 * loaded.
 */
@Global()
@Module({
  imports: [AuditContextModule],
  providers: [GatewayRegistryService, PluginInstanceRegistry],
  exports: [GatewayRegistryService, PluginInstanceRegistry],
})
class CoordinatorGlobalsModule {}

/**
 * The plugin host module mounted in a process as the coordinator mounts it:
 * beside the global gateway registry, which takes the plugin driver source
 * the module provides, and beside the plugin runtime (#1083).
 */
describe('GatewayPluginHostModule', () => {
  let module: TestingModule;
  let registry: GatewayRegistryService;
  let plugins: PluginInstanceRegistry;
  let pluginRow: PluginRow;

  /**
   * The registry's collaborators that reach outside the process. The
   * `data_gateways` table holds the one row, an enabled plugin DataGateway's
   * that passed its first interview and declares Search, read with its plugin
   * as the row stands when asked. It answers by id alone: every other filter
   * the registry sends holds for that row. The interview is done already, and
   * no config event arrives.
   */
  const collaborators = new Map<unknown, unknown>([
    [
      DatabaseService,
      {
        dataGateway: {
          findFirst: async ({ where }: { where: { id: string } }) =>
            where.id === GW
              ? {
                  id: GW,
                  name: 'Acme Games',
                  enabled: true,
                  pluginId: PLUGIN_ID,
                  plugin: { ...pluginRow },
                  firstInterviewedAt: new Date(INSTALLED_AT),
                  capabilities: [Search],
                  disabledCapabilities: [],
                  coveragePlatformTypes: [],
                  coverageContentTypes: [],
                  filterableAxes: [],
                  contentFormat: null,
                }
              : null,
        },
      },
    ],
    [
      GatewayInterviewService,
      {
        interviewUnlessDone: async () => false,
        refreshIfStale: async () => undefined,
        abandon: () => undefined,
      },
    ],
    [GatewayConfigEventsService, { subscribe: async () => async () => undefined, publish: async () => undefined }],
    [EventEmitter2, { emit: () => false }],
    // No plugin DataGateway is dialled.
    [RemoteGatewayDriverFactory, {}],
  ]);

  /**
   * Registers the plugin as the loader does once its factory returned
   * `product`. The source reads which install the copy is of and the
   * product, so the rest of what the loader records is left out.
   */
  const load = (product: unknown): void =>
    plugins.register(
      SLUG,
      {
        pluginId: PLUGIN_ID,
        slug: SLUG,
        category: PluginCategory.DataGateway,
        installedAt: new Date(INSTALLED_AT),
        instance: product,
      } as LoadedPlugin,
      { enabled: true },
    );

  beforeEach(async () => {
    pluginRow = {
      id: PLUGIN_ID,
      slug: SLUG,
      category: PluginCategory.DataGateway,
      enabled: true,
      uninstalledAt: null,
      loadFailed: false,
      installedAt: new Date(INSTALLED_AT),
      version: '1.0.0',
      installedSha256: 'a'.repeat(64),
      restartRequired: false,
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    module = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: false } }),
        CoordinatorGlobalsModule,
        GatewayPluginHostModule,
      ],
    })
      // Only what is listed above. Anything else missing fails the compile,
      // as it would fail the coordinator's boot.
      .useMocker((token) => collaborators.get(token))
      .compile();

    registry = module.get(GatewayRegistryService);
    plugins = module.get(PluginInstanceRegistry);
  });

  afterEach(async () => {
    await module.close();
    jest.restoreAllMocks();
  });

  it('provides the source under the plugin driver source token, as the one instance (#1083)', () => {
    const source = module.get(PluginDataGatewaySource);

    expect(source).toBeInstanceOf(PluginDataGatewaySource);
    expect(module.get<PluginDriverSource>(PLUGIN_DRIVER_SOURCE)).toBe(source);
  });

  it('registers the controller that answers the gateway gRPC protocol (#1083)', () => {
    expect(module.get(PluginGatewayController)).toBeInstanceOf(PluginGatewayController);
  });

  // The gateway registry's module doesn't import this one, and can't: the
  // source reaches it because the module is global and exports the token.
  // Without that the registry holds no source, and refuses every plugin
  // DataGateway as not loaded.
  it("hands the global gateway registry its source, so the registry builds a plugin DataGateway's driver from the plugin this process loaded (#1083)", async () => {
    load(() => new InMemoryGatewayDriver({ gatewayName: 'Acme Games' }));

    const driver = await registry.pluginDriver(GW, Search);

    await expect(firstValueFrom(driver.ping({ correlationId: 'c' }))).resolves.toMatchObject({
      correlationId: 'c',
      gatewayName: 'Acme Games',
    });
  });

  // The registry matches the driver it holds to the plugin's install, by
  // installedAt, which an update keeps. That is safe because an update never
  // swaps a plugin's module inside a running process: activation marks the
  // plugin restart required, and the copy in memory serves until the restart.
  it('an activated update keeps the driver built from the copy in memory, until the process restarts (#1083)', async () => {
    const factory = jest.fn(() => new InMemoryGatewayDriver());
    load(factory);
    const beforeTheUpdate = await registry.pluginDriver(GW, Search);

    pluginRow = { ...pluginRow, version: '1.1.0', installedSha256: 'b'.repeat(64), restartRequired: true };

    await expect(module.get(PluginDataGatewaySource).isLoaded(pluginRow)).resolves.toBe(true);
    await expect(registry.pluginDriver(GW, Search)).resolves.toBe(beforeTheUpdate);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  // A reinstall is another install: the copy in memory is the earlier one's,
  // so the routing decision of whatever request comes next drops its driver.
  // That request's actor only triggers the plugin's dispose.
  it("refuses a reinstall this process hasn't loaded, and disposes the earlier install's driver as the plugin (#1083)", async () => {
    const audit = module.get(AuditContextService);
    const pluginDriver = new InMemoryGatewayDriver();
    let disposedAs: Actor | null = null;
    jest.spyOn(pluginDriver, 'dispose').mockImplementation(() => {
      disposedAs = audit.getActor();
    });
    load(() => pluginDriver);
    await registry.pluginDriver(GW, Search);

    pluginRow = { ...pluginRow, installedAt: new Date('2026-11-02T00:00:00Z'), restartRequired: true };
    const refusal = await module
      .get(SystemActorScope)
      .run('a-search-reaches-the-plugin', () => registry.pluginDriver(GW, Search))
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(GatewayRoutingRefusedError);
    expect(refusal).toMatchObject({ reason: 'plugin_not_loaded' });
    expect(disposedAs).toEqual({
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      unit: { scopeType: 'Server' },
      trigger: { kind: 'system', reason: 'a-search-reaches-the-plugin' },
    });
  });
});
