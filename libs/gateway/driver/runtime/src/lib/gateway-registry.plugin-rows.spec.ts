import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService, DataGatewayCapability, PluginCategory } from '@bge/database';
import { CACHE_REDIS_CLIENT } from '@bge/redis';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Redis } from 'iovalkey';
import { setTimeout as delay } from 'node:timers/promises';
import { throwError } from 'rxjs';
import { FAILURE_THRESHOLD } from './constants/gateway-registry.constants';
import { RemoteGatewayDriverFactory } from './drivers/remote-gateway-driver.factory';
import { GatewayInterviewError } from './errors/gateway-interview.error';
import { GatewayRoutingRefusedError } from './errors/gateway-routing-refused.error';
import { GatewayDisabledEvent } from './events/gateway-registry.events';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayInterviewService } from './gateway-interview.service';
import { GatewayRegistryBootstrapService } from './gateway-registry.bootstrap.service';
import { GatewayRegistryService } from './gateway-registry.service';
import type { GatewayConfigEvent } from './interfaces';
import { PLUGIN_DRIVER_SOURCE, type PluginDriverSource, type RoutedPlugin } from './plugin-driver-source';
import { FakeDataGatewayTable } from './testing/fake-data-gateway-table';
import { VocabularySectionQueue } from './vocabulary-section.queue';

const { Search, Fetch } = DataGatewayCapability;

/** The plugin DataGateway most specs route. */
const GW = 'acme';

/** The version the in-memory driver reports on Ping. */
const IN_MEMORY_VERSION = '0.0.0-test';

/** A fixture-backed driver, with `dispose` spied so a spec can count teardowns. */
const makeDriver = () => {
  const driver = new InMemoryGatewayDriver();
  jest.spyOn(driver, 'dispose');
  return driver;
};

/** A driver whose DataGateway answers its ping but fails Describe. */
const failingInterview = () =>
  Object.assign(makeDriver(), { describe: () => throwError(() => new Error('Describe exploded')) });

/** Lets work under way go as far as it can without the test's next step. */
const settle = () => delay(0);

/** A plugin the server serves: a data-gateway plugin, switched on, installed, and loaded without a failure. */
const servedPlugin = (overrides: Partial<RoutedPlugin> = {}): RoutedPlugin => ({
  id: 'plugin-1',
  slug: 'acme-games',
  category: PluginCategory.DataGateway,
  enabled: true,
  uninstalledAt: null,
  loadFailed: false,
  installedAt: new Date('2026-11-01T00:00:00Z'),
  ...overrides,
});

describe("The gateway registry and a plugin DataGateway's row (#1083)", () => {
  let service: GatewayRegistryService;
  let bootstrap: GatewayRegistryBootstrapService;
  let emitter: EventEmitter2;
  let table: FakeDataGatewayTable;
  let factory: { create: jest.Mock };
  let source: jest.Mocked<PluginDriverSource>;

  /** The gateway registry's module over the table, with `pluginDrivers` as its plugin driver source, or with none. */
  const moduleWith = (pluginDrivers?: PluginDriverSource): Promise<TestingModule> => {
    const redisMock = {
      duplicate: () => redisMock,
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      publish: jest.fn(),
      quit: jest.fn(),
      on: jest.fn(),
    } as unknown as Redis;

    return Test.createTestingModule({
      providers: [
        GatewayRegistryService,
        GatewayRegistryBootstrapService,
        GatewayInterviewService,
        GatewayConfigEventsService,
        EventEmitter2,
        { provide: RemoteGatewayDriverFactory, useValue: factory },
        { provide: DatabaseService, useValue: { dataGateway: table.delegate } },
        { provide: CACHE_REDIS_CLIENT, useValue: redisMock },
        { provide: SystemActorScope, useValue: { run: jest.fn((_reason: string, fn: () => unknown) => fn()) } },
        { provide: VocabularySectionQueue, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
        ...(pluginDrivers ? [{ provide: PLUGIN_DRIVER_SOURCE, useValue: pluginDrivers }] : []),
      ],
    }).compile();
  };

  const dispatch = (event: GatewayConfigEvent): Promise<void> =>
    (service as unknown as { handleConfigUpdate(e: GatewayConfigEvent): Promise<void> }).handleConfigUpdate(event);

  /** A plugin's row whose first interview declared Search and Fetch, just now, at the in-memory driver's version. */
  const interviewedRow = (id: string, plugin: RoutedPlugin = servedPlugin()) =>
    table.seed({
      id,
      plugin,
      capabilities: [Search, Fetch],
      gatewayVersion: IN_MEMORY_VERSION,
      firstInterviewedAt: new Date(),
      lastInterviewedAt: new Date(),
    });

  beforeEach(async () => {
    table = new FakeDataGatewayTable();
    factory = { create: jest.fn() };
    source = {
      isLoaded: jest.fn().mockResolvedValue(true),
      build: jest.fn().mockImplementation(async () => makeDriver()),
    };

    const module = await moduleWith(source);
    service = module.get(GatewayRegistryService);
    bootstrap = module.get(GatewayRegistryBootstrapService);
    emitter = module.get(EventEmitter2);
  });

  afterEach(() => jest.restoreAllMocks());

  // The last is a plugin an update moved to another category: its row stays, and is no plugin's to serve.
  it('refuses a plugin row whose plugin is disabled, uninstalled, quarantined or no longer a data-gateway plugin, without asking the source (#1083)', async () => {
    interviewedRow('disabled', servedPlugin({ id: 'p-disabled', enabled: false }));
    interviewedRow('uninstalled', servedPlugin({ id: 'p-uninstalled', uninstalledAt: new Date() }));
    interviewedRow('quarantined', servedPlugin({ id: 'p-quarantined', loadFailed: true }));
    interviewedRow('recategorized', servedPlugin({ id: 'p-moved', category: PluginCategory.EventHook }));

    for (const id of ['disabled', 'uninstalled', 'quarantined', 'recategorized']) {
      await expect(service.resolve(id, Search)).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        reason: 'plugin_not_served',
        message: `DataGateway ${id}'s plugin is disabled, uninstalled, failed to load or is no longer a data-gateway plugin`,
      });
    }

    expect(source.isLoaded).not.toHaveBeenCalled();
    expect(source.build).not.toHaveBeenCalled();
  });

  it('refuses a plugin row when no source is provided (#1083)', async () => {
    interviewedRow(GW);
    const unsourced = (await moduleWith()).get(GatewayRegistryService);

    await expect(unsourced.resolve(GW, Search)).rejects.toMatchObject({
      name: GatewayRoutingRefusedError.name,
      reason: 'plugin_not_loaded',
      message: `DataGateway ${GW}'s plugin isn't loaded: restart the coordinator`,
    });
  });

  it('refuses a plugin row the source says is not loaded, and drops its cached driver', async () => {
    table.seed({ id: GW, plugin: servedPlugin() });
    const driver = makeDriver();
    source.build.mockResolvedValueOnce(driver);
    await service.resolve(GW, Search);

    source.isLoaded.mockResolvedValue(false);

    await expect(service.resolve(GW, Search)).rejects.toMatchObject({
      name: GatewayRoutingRefusedError.name,
      reason: 'plugin_not_loaded',
    });
    expect(driver.dispose).toHaveBeenCalledTimes(1);
    expect(service.isConnected(GW)).toBe(false);
  });

  // Uninstalling a plugin disables its row and publishes no config event, as
  // does an update that moves it to another category. Nothing but the next
  // routing decision can dispose the driver, with whatever handles and timers
  // the plugin gave it.
  it.each<[string, Partial<RoutedPlugin>]>([
    ['uninstalled', { enabled: false, uninstalledAt: new Date() }],
    ['updated into another category', { category: PluginCategory.EventHook }],
  ])(
    'disposes the driver it holds for a plugin that was %s, at the next routing decision (#1083)',
    async (_state, change) => {
      table.seed({ id: GW, plugin: servedPlugin() });
      const driver = makeDriver();
      source.build.mockResolvedValueOnce(driver);
      await service.resolve(GW, Search);

      // Each disables the plugin's row in the transaction that changes the plugin.
      table.patch(GW, { enabled: false, plugin: servedPlugin(change) });

      await expect(service.resolve(GW, Search)).rejects.toMatchObject({ reason: 'disabled' });
      expect(driver.dispose).toHaveBeenCalledTimes(1);
      expect(service.isConnected(GW)).toBe(false);
    },
  );

  // Disposing it would fail the calls still under way, and those would count
  // toward disabling a DataGateway that did nothing wrong.
  it('keeps the driver of a plugin that was only switched off, unused, and hands it out again once the plugin is switched on (#1083)', async () => {
    table.seed({ id: GW, plugin: servedPlugin() });
    const driver = makeDriver();
    source.build.mockResolvedValueOnce(driver);
    await service.resolve(GW, Search);

    table.patch(GW, { plugin: servedPlugin({ enabled: false }) });
    await expect(service.resolve(GW, Search)).rejects.toMatchObject({ reason: 'plugin_not_served' });
    expect(driver.dispose).not.toHaveBeenCalled();

    table.patch(GW, { plugin: servedPlugin() });
    await expect(service.resolve(GW, Search)).resolves.toBe(driver);
    expect(source.build).toHaveBeenCalledTimes(1);
  });

  // Between two uses the plugin was uninstalled and installed again, and no
  // routing decision saw its row disabled. The source answers for the
  // install the row names now, so it says loaded, and the driver held is the
  // earlier install's, reaching a copy that is gone.
  it('drops the driver of an earlier install of the plugin and builds one from the install the row names now (#1083)', async () => {
    interviewedRow(GW);
    const earlier = makeDriver();
    const reinstalled = makeDriver();
    source.build.mockResolvedValueOnce(earlier).mockResolvedValueOnce(reinstalled);
    await expect(service.resolve(GW, Search)).resolves.toBe(earlier);

    const installedAt = new Date('2026-11-02T00:00:00Z');
    table.patch(GW, { plugin: servedPlugin({ installedAt }) });

    await expect(service.resolve(GW, Search)).resolves.toBe(reinstalled);
    expect(earlier.dispose).toHaveBeenCalledTimes(1);
    expect(source.build).toHaveBeenLastCalledWith(GW, expect.objectContaining({ installedAt }));
  });

  // The build had begun from the earlier install's copy. Its own call gets
  // that driver, as a call already under way does; the next decision drops it.
  it('drops a driver whose build finished after the plugin was reinstalled, at the next routing decision (#1083)', async () => {
    interviewedRow(GW);
    const earlier = makeDriver();
    const reinstalled = makeDriver();
    let finishBuild!: (driver: DataGatewayDriver) => void;
    source.build
      .mockReturnValueOnce(new Promise<DataGatewayDriver>((resolve) => (finishBuild = resolve)))
      .mockResolvedValueOnce(reinstalled);

    const resolving = service.resolve(GW, Search);
    await settle();
    expect(source.build).toHaveBeenCalledTimes(1);

    table.patch(GW, { plugin: servedPlugin({ installedAt: new Date('2026-11-02T00:00:00Z') }) });
    finishBuild(earlier);
    await expect(resolving).resolves.toBe(earlier);

    await expect(service.resolve(GW, Search)).resolves.toBe(reinstalled);
    expect(earlier.dispose).toHaveBeenCalledTimes(1);
  });

  // A remote DataGateway's driver is the config events' to take down, as before.
  it('leaves a remote row its driver when a routing decision refuses it', async () => {
    table.seed({ id: 'remote' });
    const driver = makeDriver();
    factory.create.mockResolvedValueOnce(driver);
    await service.resolve('remote', Search);

    table.patch('remote', { enabled: false });

    await expect(service.resolve('remote', Search)).rejects.toMatchObject({ reason: 'disabled' });
    expect(driver.dispose).not.toHaveBeenCalled();
    expect(service.isConnected('remote')).toBe(true);
  });

  // The source's lookup failed: that says nothing of the plugin's copy, and
  // nothing of any other DataGateway.
  it('refuses one DataGateway whose source could not say whether its plugin is loaded, keeps its driver, and routes the rest (#1083)', async () => {
    table.seed({ id: 'remote' });
    factory.create.mockResolvedValueOnce(makeDriver());
    await service.resolve('remote', Search);
    const drivers = { steady: makeDriver(), unsure: makeDriver() };
    table.seed({ id: 'steady', plugin: servedPlugin({ id: 'p-steady' }) });
    table.seed({ id: 'unsure', plugin: servedPlugin({ id: 'p-unsure' }) });
    source.build.mockImplementation(async (gatewayId) => drivers[gatewayId as keyof typeof drivers]);
    await service.resolve('steady', Search);
    await service.resolve('unsure', Search);
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    source.isLoaded.mockImplementation(async (plugin) => {
      if (plugin.id === 'p-unsure') {
        throw new Error('The load records are unreachable');
      }

      return true;
    });

    await expect(service.routableGatewayIds(Search)).resolves.toEqual(['remote', 'steady']);
    await expect(service.searchRoute('unsure', {})).resolves.toEqual({ routable: false });
    await expect(service.resolve('unsure', Search)).rejects.toMatchObject({
      name: GatewayRoutingRefusedError.name,
      reason: 'plugin_not_loaded',
    });
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('The load records are unreachable'));
    expect(drivers.unsure.dispose).not.toHaveBeenCalled();
    expect(service.isConnected('unsure')).toBe(true);
  });

  it('an enabled row of a disabled plugin is refused before its first interview', async () => {
    table.seed({ id: GW, plugin: servedPlugin({ enabled: false }) });
    const reads = jest.spyOn(table.delegate, 'findFirst');

    await expect(service.resolve(GW, Search)).rejects.toMatchObject({
      name: GatewayRoutingRefusedError.name,
      reason: 'plugin_not_served',
      capability: Search,
    });

    expect(source.build).not.toHaveBeenCalled();
    expect(table.row(GW)?.firstInterviewedAt).toBeNull();
    // Decided from the one read of its row: no connect went on to read it again.
    expect(reads).toHaveBeenCalledTimes(1);
  });

  // Each row here fails every later check too, so the reason given is the first that holds.
  it('refuses for the row first, then the plugin, then whether it is loaded, then the capability (#1083)', async () => {
    interviewedRow('row-disabled', servedPlugin({ id: 'p-1', enabled: false }));
    interviewedRow('plugin-off', servedPlugin({ id: 'p-2', enabled: false }));
    interviewedRow('not-loaded', servedPlugin({ id: 'p-3' }));
    table.patch('row-disabled', { enabled: false, capabilities: [Fetch] });
    table.patch('plugin-off', { capabilities: [Fetch] });
    table.patch('not-loaded', { capabilities: [Fetch] });
    source.isLoaded.mockResolvedValue(false);

    await expect(service.resolve('row-disabled', Search)).rejects.toMatchObject({ reason: 'disabled' });
    await expect(service.resolve('plugin-off', Search)).rejects.toMatchObject({ reason: 'plugin_not_served' });
    await expect(service.resolve('not-loaded', Search)).rejects.toMatchObject({ reason: 'plugin_not_loaded' });
  });

  it("builds a plugin row's driver from the source and never from the remote factory (#1083)", async () => {
    const plugin = servedPlugin();
    table.seed({ id: GW, plugin });
    const driver = makeDriver();
    source.build.mockResolvedValueOnce(driver);

    await expect(service.resolve(GW, Search)).resolves.toBe(driver);

    expect(source.build).toHaveBeenCalledWith(GW, plugin);
    expect(factory.create).not.toHaveBeenCalled();
    expect(table.row(GW)?.firstInterviewedAt).toEqual(expect.any(Date));
  });

  it('builds a new driver after the first one is disconnected', async () => {
    table.seed({ id: GW, plugin: servedPlugin() });
    const first = await service.resolve(GW, Search);

    service.disconnect(GW);
    const second = await service.resolve(GW, Search);

    expect(source.build).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('tries a failed first interview again on the next use (#1083)', async () => {
    table.seed({ id: GW, plugin: servedPlugin() });
    const failed = failingInterview();
    const recovered = makeDriver();
    source.build.mockResolvedValueOnce(failed).mockResolvedValueOnce(recovered);

    await expect(service.resolve(GW, Search)).rejects.toBeInstanceOf(GatewayInterviewError);
    expect(failed.dispose).toHaveBeenCalledTimes(1);
    expect(service.isConnected(GW)).toBe(false);

    await expect(service.resolve(GW, Search)).resolves.toBe(recovered);
    expect(source.build).toHaveBeenCalledTimes(2);
  });

  it('counts a failed build as a connection failure, and a refusal from the source as none', async () => {
    interviewedRow('failing', servedPlugin({ id: 'p-failing' }));
    interviewedRow('refused', servedPlugin({ id: 'p-refused' }));
    source.build.mockImplementation(async (gatewayId) => {
      throw gatewayId === 'refused'
        ? new GatewayRoutingRefusedError(gatewayId, 'plugin_not_loaded')
        : new Error('The driver factory exploded');
    });
    const emitSpy = jest.spyOn(emitter, 'emit');
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt++) {
      await expect(service.resolve('failing', Search)).rejects.toThrow('The driver factory exploded');
      await expect(service.resolve('refused', Search)).rejects.toMatchObject({ reason: 'plugin_not_loaded' });
    }

    // Auto-disable is how a counted failure shows: the threshold's worth disables the row.
    expect(table.row('failing')?.enabled).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith(
      GatewayDisabledEvent.eventName,
      expect.objectContaining({
        subjectId: 'failing',
        failure: expect.objectContaining({ reason: 'repeated_connection_failure' }),
      }),
    );
    expect(table.row('refused')?.enabled).toBe(true);
  });

  it('ignores an updated event for a plugin driver and rebuilds on reconnect-requested', async () => {
    table.seed({ id: GW, plugin: servedPlugin() });
    const first = makeDriver();
    const rebuilt = makeDriver();
    source.build.mockResolvedValueOnce(first).mockResolvedValueOnce(rebuilt);
    await service.resolve(GW, Search);

    // An edit to the row changes nothing a rebuilt driver would be built from.
    await dispatch({ gatewayId: GW, configHash: 'another-hash', changeType: 'updated', timestamp: 0 });

    expect(first.dispose).not.toHaveBeenCalled();
    await expect(service.resolve(GW, Search)).resolves.toBe(first);

    await dispatch({ gatewayId: GW, configHash: '', changeType: 'reconnect-requested', timestamp: 0 });

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(source.build).toHaveBeenCalledTimes(2);
    await expect(service.resolve(GW, Search)).resolves.toBe(rebuilt);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'deleted'] as const)(
    'tears down a plugin driver on a %s event, as it does any driver',
    async (changeType) => {
      table.seed({ id: GW, plugin: servedPlugin() });
      const driver = makeDriver();
      source.build.mockResolvedValueOnce(driver);
      await service.resolve(GW, Search);

      await dispatch({ gatewayId: GW, configHash: '', changeType, timestamp: 0 });

      expect(driver.dispose).toHaveBeenCalledTimes(1);
      expect(service.isConnected(GW)).toBe(false);
    },
  );

  it('discards a driver built while its row was being disabled, instead of caching it (#1083)', async () => {
    interviewedRow(GW);
    const driver = makeDriver();
    let finishBuild!: (driver: DataGatewayDriver) => void;
    source.build.mockReturnValue(new Promise<DataGatewayDriver>((resolve) => (finishBuild = resolve)));

    const resolving = service.resolve(GW, Search);
    await settle();
    expect(source.build).toHaveBeenCalledTimes(1);

    // Mid-build nothing is cached, so the event finds no driver to tear down.
    await dispatch({ gatewayId: GW, configHash: '', changeType: 'disabled', timestamp: 0 });
    finishBuild(driver);

    // The caller finds no driver, as it does when a remote connect is invalidated.
    await expect(resolving).rejects.toThrow();
    expect(driver.dispose).toHaveBeenCalledTimes(1);
    expect(service.isConnected(GW)).toBe(false);
  });

  // Nothing is cached mid-build for the decision to drop. Cached afterwards,
  // the driver of the copy that went would be served once a new copy loads.
  it('discards a driver built while a routing decision found its plugin no longer loaded (#1083)', async () => {
    interviewedRow(GW);
    const driver = makeDriver();
    let finishBuild!: (driver: DataGatewayDriver) => void;
    source.build.mockReturnValue(new Promise<DataGatewayDriver>((resolve) => (finishBuild = resolve)));

    const resolving = service.resolve(GW, Search);
    await settle();
    expect(source.build).toHaveBeenCalledTimes(1);

    source.isLoaded.mockResolvedValue(false);
    await expect(service.searchRoute(GW, {})).resolves.toEqual({ routable: false });
    finishBuild(driver);

    await expect(resolving).rejects.toThrow();
    expect(driver.dispose).toHaveBeenCalledTimes(1);
    expect(service.isConnected(GW)).toBe(false);
  });

  it('pluginDriver refuses a remote row as unknown', async () => {
    table.seed({
      id: 'remote',
      capabilities: [Search, Fetch],
      gatewayVersion: IN_MEMORY_VERSION,
      firstInterviewedAt: new Date(),
      lastInterviewedAt: new Date(),
    });

    await expect(service.pluginDriver('remote', Search)).rejects.toMatchObject({
      name: GatewayRoutingRefusedError.name,
      reason: 'unknown',
    });
    await expect(service.pluginDriver('remote')).rejects.toMatchObject({
      name: GatewayRoutingRefusedError.name,
      reason: 'unknown',
    });
    expect(factory.create).not.toHaveBeenCalled();
  });

  // A call that names no capability, such as a ping, still needs the driver.
  it('pluginDriver builds and interviews a row this process holds no driver for when no capability is named (#1083)', async () => {
    table.seed({ id: GW, plugin: servedPlugin() });
    const driver = makeDriver();
    source.build.mockResolvedValueOnce(driver);

    await expect(service.pluginDriver(GW)).resolves.toBe(driver);

    expect(table.row(GW)?.firstInterviewedAt).toEqual(expect.any(Date));
    await expect(service.pluginDriver(GW, Search)).resolves.toBe(driver);
    expect(source.build).toHaveBeenCalledTimes(1);
  });

  it('pluginDriver refuses as resolve does: for the plugin with or without a capability, for the capability with one', async () => {
    interviewedRow('fetches-only', servedPlugin({ id: 'p-fetches' }));
    table.patch('fetches-only', { capabilities: [Fetch] });
    interviewedRow('not-served', servedPlugin({ id: 'p-off', enabled: false }));
    interviewedRow('not-loaded', servedPlugin({ id: 'p-gone' }));
    source.isLoaded.mockImplementation(async (plugin) => plugin.id !== 'p-gone');

    await expect(service.pluginDriver('fetches-only', Search)).rejects.toMatchObject({ reason: 'not_declared' });
    await expect(service.pluginDriver('not-served')).rejects.toMatchObject({ reason: 'plugin_not_served' });
    await expect(service.pluginDriver('not-served', Search)).rejects.toMatchObject({ reason: 'plugin_not_served' });
    await expect(service.pluginDriver('not-loaded')).rejects.toMatchObject({ reason: 'plugin_not_loaded' });
    await expect(service.pluginDriver('not-loaded', Search)).rejects.toMatchObject({ reason: 'plugin_not_loaded' });
    await expect(service.pluginDriver('gone')).rejects.toMatchObject({ reason: 'unknown' });
    expect(source.build).not.toHaveBeenCalled();
  });

  describe('every other routing decision applies the same refusals (#1083)', () => {
    it('searchRoute marks a plugin row unroutable while its plugin is not served or not loaded, building nothing', async () => {
      interviewedRow('served', servedPlugin({ id: 'p-on' }));
      interviewedRow('not-served', servedPlugin({ id: 'p-off', uninstalledAt: new Date() }));
      interviewedRow('not-loaded', servedPlugin({ id: 'p-gone' }));
      source.isLoaded.mockImplementation(async (plugin) => plugin.id !== 'p-gone');

      await expect(service.searchRoute('served', {})).resolves.toMatchObject({ routable: true });
      await expect(service.searchRoute('not-served', {})).resolves.toEqual({ routable: false });
      await expect(service.searchRoute('not-loaded', {})).resolves.toEqual({ routable: false });
      expect(source.build).not.toHaveBeenCalled();
    });

    it('routableGatewayIds lists a connected plugin row only while its plugin is served and loaded', async () => {
      for (const [id, pluginId] of [
        ['served', 'p-on'],
        ['switched-off', 'p-off'],
        ['reinstalled', 'p-gone'],
      ]) {
        table.seed({ id, plugin: servedPlugin({ id: pluginId }) });
        await service.resolve(id, Search);
      }
      await expect(service.routableGatewayIds(Search)).resolves.toEqual(['served', 'switched-off', 'reinstalled']);

      table.patch('switched-off', { plugin: servedPlugin({ id: 'p-off', enabled: false }) });
      source.isLoaded.mockImplementation(async (plugin) => plugin.id !== 'p-gone');

      await expect(service.routableGatewayIds(Search)).resolves.toEqual(['served']);
    });

    it('reinterview refuses a plugin row whose plugin stopped being served or loaded, though this process holds its driver', async () => {
      const held = { 'switched-off': makeDriver(), reinstalled: makeDriver() };
      table.seed({ id: 'switched-off', plugin: servedPlugin({ id: 'p-off' }) });
      table.seed({ id: 'reinstalled', plugin: servedPlugin({ id: 'p-gone' }) });
      source.build.mockImplementation(async (gatewayId) => held[gatewayId as keyof typeof held]);
      await service.resolve('switched-off', Search);
      await service.resolve('reinstalled', Search);
      const asked = [jest.spyOn(held['switched-off'], 'describe'), jest.spyOn(held.reinstalled, 'describe')];

      table.patch('switched-off', { plugin: servedPlugin({ id: 'p-off', enabled: false }) });
      source.isLoaded.mockImplementation(async (plugin) => plugin.id !== 'p-gone');

      await expect(service.reinterview('switched-off')).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        reason: 'plugin_not_served',
      });
      await expect(service.reinterview('reinstalled')).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        reason: 'plugin_not_loaded',
      });
      asked.forEach((describe) => expect(describe).not.toHaveBeenCalled());
    });
  });

  // The hourly backstop reaches whatever driver this process holds, and a
  // plugin's driver outlives its plugin being switched off: no config event
  // tells of a plugin's state. So it decides as routing does before it asks
  // anything, or a plugin behind its server switch would still be called. The
  // decision also disposes the driver of a plugin whose row was disabled under
  // it, so that one isn't held past the next tick (#1083).
  describe('the interview backstop', () => {
    /** A plugin's row this process built a driver for and still holds, with a watch on the driver's ping. */
    const heldDriver = async () => {
      table.seed({ id: GW, plugin: servedPlugin() });
      const driver = makeDriver();
      source.build.mockResolvedValueOnce(driver);
      await service.resolve(GW, Search);
      await settle();

      return { driver, ping: jest.spyOn(driver, 'ping') };
    };

    it.each<[string, Partial<RoutedPlugin>]>([
      ['switched off', { enabled: false }],
      ['uninstalled', { uninstalledAt: new Date() }],
      ['quarantined', { loadFailed: true }],
      ['updated into another category', { category: PluginCategory.EventHook }],
    ])('asks nothing of a plugin that was %s, though this process holds its driver (#1083)', async (_state, change) => {
      const { ping } = await heldDriver();
      table.patch(GW, { plugin: servedPlugin(change) });

      await service.refreshInterview(GW);

      expect(ping).not.toHaveBeenCalled();
    });

    it('disposes the driver of a plugin whose row an uninstall disabled, with no config event to say so (#1083)', async () => {
      const { driver, ping } = await heldDriver();
      table.patch(GW, { enabled: false, plugin: servedPlugin({ enabled: false, uninstalledAt: new Date() }) });

      await service.refreshInterview(GW);

      expect(ping).not.toHaveBeenCalled();
      expect(driver.dispose).toHaveBeenCalledTimes(1);
      expect(service.isConnected(GW)).toBe(false);
    });

    it('asks nothing of a plugin the source says is no longer loaded, and drops its driver (#1083)', async () => {
      const { driver, ping } = await heldDriver();
      source.isLoaded.mockResolvedValue(false);

      await service.refreshInterview(GW);

      expect(ping).not.toHaveBeenCalled();
      expect(driver.dispose).toHaveBeenCalledTimes(1);
      expect(service.isConnected(GW)).toBe(false);
    });

    it('still interviews a served, loaded plugin again when its answers have gone stale', async () => {
      await heldDriver();
      table.patch(GW, { gatewayVersion: '0.0.0-older' });

      await service.refreshInterview(GW);

      expect(table.row(GW)?.gatewayVersion).toBe(IN_MEMORY_VERSION);
    });

    // The backstop's timer has no caller to answer to: a decision it can't make skips the check.
    it('never throws when the source or the read of the row fails, asks the plugin nothing and keeps its driver (#1083)', async () => {
      const { driver, ping } = await heldDriver();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      source.isLoaded.mockRejectedValueOnce(new Error('The load records are unreachable'));
      await expect(service.refreshInterview(GW)).resolves.toBeUndefined();

      const read = jest
        .spyOn(table.delegate, 'findFirst')
        .mockRejectedValueOnce(new Error('The database is unreachable'));
      await expect(service.refreshInterview(GW)).resolves.toBeUndefined();

      // The second check got as far as the read, so the first dropped nothing.
      expect(read).toHaveBeenCalledTimes(1);
      expect(ping).not.toHaveBeenCalled();
      expect(driver.dispose).not.toHaveBeenCalled();
      expect(service.isConnected(GW)).toBe(true);
    });
  });

  describe('GatewayRegistryBootstrapService', () => {
    it('leaves plugin rows out of the boot connect', async () => {
      table.seed({ id: 'remote' });
      table.seed({ id: GW, plugin: servedPlugin() });
      factory.create.mockResolvedValue(makeDriver());
      const read = jest.spyOn(table.delegate, 'findMany');

      await bootstrap.onApplicationBootstrap();

      // The boot connect doesn't so much as read a plugin's row: a plugin
      // DataGateway connects on first use, once the plugin loader has run.
      await expect(read.mock.results[0].value).resolves.toEqual([expect.objectContaining({ id: 'remote' })]);
      expect(service.connectedGatewayIds()).toEqual(['remote']);
      expect(source.build).not.toHaveBeenCalled();
    });

    // The table's CHECK forbids the row. If one turns up all the same, the
    // boot connect says which, as the lazy connect does by throwing.
    it('names a remote row with no connection fields instead of skipping it in silence, and connects the rest', async () => {
      table.seed({ id: 'broken', name: 'Broken', connectionUrl: null });
      table.seed({ id: 'remote' });
      factory.create.mockResolvedValue(makeDriver());
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await bootstrap.onApplicationBootstrap();

      expect(logged).toHaveBeenCalledWith(expect.stringContaining("'Broken' (broken) has no connection fields"));
      expect(service.connectedGatewayIds()).toEqual(['remote']);
    });
  });

  // A connect that follows no routing decision still decides for itself, so
  // no path builds a driver for a plugin that isn't served and loaded (#1083).
  describe('a connect no routing decision came before', () => {
    it('builds nothing on reconnect-requested for a plugin that is not served or not loaded, and counts no failure (#1083)', async () => {
      interviewedRow('not-served', servedPlugin({ id: 'p-off', enabled: false }));
      interviewedRow('not-loaded', servedPlugin({ id: 'p-gone' }));
      source.isLoaded.mockImplementation(async (plugin) => plugin.id !== 'p-gone');
      const counted = jest.spyOn(service, 'reportFailure');

      await dispatch({ gatewayId: 'not-served', configHash: '', changeType: 'reconnect-requested', timestamp: 0 });
      await dispatch({ gatewayId: 'not-loaded', configHash: '', changeType: 'reconnect-requested', timestamp: 0 });

      expect(source.build).not.toHaveBeenCalled();
      expect(service.connectedGatewayIds()).toEqual([]);
      // A reconnect request clears the row's failure count, so the row staying
      // enabled would say nothing here. The count itself is watched.
      expect(counted).not.toHaveBeenCalled();
    });

    it('logs a build when it builds, and none for a connect it refuses (#1083)', async () => {
      interviewedRow('served', servedPlugin({ id: 'p-on' }));
      interviewedRow('not-served', servedPlugin({ id: 'p-off', enabled: false }));
      const logged = jest.spyOn(Logger.prototype, 'log');
      const builds = () => logged.mock.calls.filter(([message]) => String(message).includes('building the driver'));

      await dispatch({ gatewayId: 'not-served', configHash: '', changeType: 'reconnect-requested', timestamp: 0 });
      expect(builds()).toHaveLength(0);

      await dispatch({ gatewayId: 'served', configHash: '', changeType: 'reconnect-requested', timestamp: 0 });
      expect(builds()).toHaveLength(1);
    });

    // A route whose driver this process already holds hands that driver out:
    // the route isn't decided again. What holds is that none is built.
    it("builds no driver for a search route's driver() once the plugin stopped being served or loaded after the route was read (#1083)", async () => {
      interviewedRow('switched-off', servedPlugin({ id: 'p-off' }));
      interviewedRow('reinstalled', servedPlugin({ id: 'p-gone' }));
      const switchedOff = await service.searchRoute('switched-off', {});
      const reinstalled = await service.searchRoute('reinstalled', {});

      table.patch('switched-off', { plugin: servedPlugin({ id: 'p-off', enabled: false }) });
      source.isLoaded.mockResolvedValue(false);

      await expect(switchedOff.routable && switchedOff.driver()).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        reason: 'plugin_not_served',
      });
      await expect(reinstalled.routable && reinstalled.driver()).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        reason: 'plugin_not_loaded',
      });
      expect(source.build).not.toHaveBeenCalled();
    });
  });
});
