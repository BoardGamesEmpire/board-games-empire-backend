import { SystemActorScope } from '@bge/actor-context';
import {
  AuthType,
  ContentFormat,
  ContentType,
  DatabaseService,
  DataGatewayCapability,
  DataGatewayInterviewFailure,
  PlatformType,
  SearchFilterAxis,
} from '@bge/database';
import { CACHE_REDIS_CLIENT } from '@bge/redis';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { InMemoryGatewayDriver, type InMemoryGatewayFixtures } from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type { Redis } from 'iovalkey';
import { setTimeout as delay } from 'node:timers/promises';
import { concatMap, from, throwError } from 'rxjs';
import { FAILURE_THRESHOLD } from './constants/gateway-registry.constants';
import { RemoteGatewayDriverFactory } from './drivers/remote-gateway-driver.factory';
import { GatewayInterviewError } from './errors/gateway-interview.error';
import { GatewayRoutingRefusedError } from './errors/gateway-routing-refused.error';
import { GatewayDisabledEvent } from './events/gateway-registry.events';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayInterviewService } from './gateway-interview.service';
import { coverageOverlaps, GatewayRegistryService, type StoredCoverage } from './gateway-registry.service';
import type { GatewayConfigEvent } from './interfaces';
import { FakeDataGatewayTable } from './testing/fake-data-gateway-table';
import { VocabularySectionQueue } from './vocabulary-section.queue';

const { Search, Fetch, FetchExpansions, ListLanguages, ListPlatforms, ListCategories, ListMechanics } =
  DataGatewayCapability;
const EVERY_CAPABILITY = [Search, Fetch, FetchExpansions, ListLanguages, ListPlatforms, ListCategories, ListMechanics];
const { Tabletop } = PlatformType;

/** What a board-game DataGateway covers. */
const TABLETOP_GAMES: StoredCoverage = {
  coveragePlatformTypes: [Tabletop],
  coverageContentTypes: [ContentType.BaseGame, ContentType.Expansion],
};

/** What a video-game DataGateway covers. */
const VIDEO_GAMES: StoredCoverage = {
  coveragePlatformTypes: [PlatformType.Console, PlatformType.PC],
  coverageContentTypes: [ContentType.BaseGame, ContentType.DLC],
};

/** The version the in-memory driver reports on Ping. */
const IN_MEMORY_VERSION = '0.0.0-test';

const DAY = 24 * 60 * 60 * 1000;

/** A fixture-backed driver, with `dispose` spied so a spec can count teardowns. */
const makeDriver = (fixtures: InMemoryGatewayFixtures = {}) => {
  const driver = new InMemoryGatewayDriver(fixtures);
  jest.spyOn(driver, 'dispose');
  return driver;
};

/** A driver whose DataGateway answers its ping but fails Describe. */
const failingInterview = () =>
  Object.assign(makeDriver(), { describe: () => throwError(() => new Error('Describe exploded')) });

/** Lets background work, such as a connect's check for stale answers, run to the end. */
const settle = () => delay(0);

describe('GatewayRegistryService', () => {
  let service: GatewayRegistryService;
  let table: FakeDataGatewayTable;
  let emitter: EventEmitter2;
  let systemActorScope: { run: jest.Mock };
  let factory: { create: jest.Mock };

  /** Routes the factory to a ready driver, as a successful remote connect would. */
  const stubFactory = <T extends DataGatewayDriver>(driver: T): T => {
    factory.create.mockResolvedValue(driver);
    return driver;
  };

  /** A row whose first interview declared `capabilities`, just now, at the in-memory driver's version. */
  const interviewedRow = (id: string, capabilities = EVERY_CAPABILITY) =>
    table.seed({
      id,
      capabilities,
      gatewayVersion: IN_MEMORY_VERSION,
      firstInterviewedAt: new Date(),
      lastInterviewedAt: new Date(),
    });

  /** An interviewed row that declared `coverage`, and that its search narrows by `filterableAxes`. */
  const coveringRow = (id: string, coverage: StoredCoverage, filterableAxes: SearchFilterAxis[] = []) => {
    interviewedRow(id);
    table.patch(id, { ...coverage, filterableAxes });
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

    table = new FakeDataGatewayTable();
    systemActorScope = { run: jest.fn((_reason: string, fn: () => unknown) => fn()) };
    factory = { create: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        GatewayRegistryService,
        GatewayInterviewService,
        GatewayConfigEventsService,
        EventEmitter2,
        { provide: RemoteGatewayDriverFactory, useValue: factory },
        { provide: DatabaseService, useValue: { dataGateway: table.delegate } },
        { provide: CACHE_REDIS_CLIENT, useValue: redisMock },
        { provide: SystemActorScope, useValue: systemActorScope },
        { provide: VocabularySectionQueue, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(GatewayRegistryService);
    emitter = module.get(EventEmitter2);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports no connected gateways initially', () => {
    expect(service.connectedGatewayIds()).toEqual([]);
  });

  describe('the first interview', () => {
    it('runs on connect, before the driver is cached, so the DataGateway is routed straight away', async () => {
      table.seed({ id: 'bgg' });
      const driver = stubFactory(makeDriver());

      await service.connect(connectOpts);

      expect(table.row('bgg')).toMatchObject({ capabilities: EVERY_CAPABILITY, firstInterviewedAt: expect.any(Date) });
      await expect(service.resolve('bgg', Search)).resolves.toBe(driver);
    });

    it('fails the connect, disposes the driver and caches nothing when it fails', async () => {
      table.seed({ id: 'bgg' });
      const driver = stubFactory(failingInterview());

      await expect(service.connect(connectOpts)).rejects.toBeInstanceOf(GatewayInterviewError);

      expect(driver.disposed).toBe(true);
      expect(service.isConnected('bgg')).toBe(false);
      expect(table.row('bgg')).toMatchObject({
        firstInterviewedAt: null,
        lastInterviewFailure: DataGatewayInterviewFailure.DescribeFailed,
      });
    });

    it('never counts a failed interview toward auto-disable', async () => {
      table.seed({ id: 'bgg' });
      factory.create.mockImplementation(async () => failingInterview());
      const emitSpy = jest.spyOn(emitter, 'emit');

      for (let attempt = 0; attempt < FAILURE_THRESHOLD + 1; attempt++) {
        await expect(service.connect(connectOpts)).rejects.toThrow();
      }

      expect(table.row('bgg')?.enabled).toBe(true);
      expect(emitSpy).not.toHaveBeenCalledWith(GatewayDisabledEvent.eventName, expect.anything());
    });

    it('is skipped when the row shows it already, as when the other process got there first', async () => {
      interviewedRow('bgg');
      const driver = stubFactory(makeDriver());
      const describe = jest.spyOn(driver, 'describe');

      await service.connect(connectOpts);
      await settle();

      expect(describe).not.toHaveBeenCalled();
      expect(service.isConnected('bgg')).toBe(true);
    });

    it('is followed, on a later connect, by a background interview when the answers are a day old', async () => {
      const stale = new Date(Date.now() - 2 * DAY);
      table.seed({
        id: 'bgg',
        capabilities: [Fetch],
        gatewayVersion: IN_MEMORY_VERSION,
        firstInterviewedAt: stale,
        lastInterviewedAt: stale,
      });
      stubFactory(makeDriver());

      await service.connect(connectOpts);
      await settle();

      expect(table.row('bgg')).toMatchObject({ capabilities: EVERY_CAPABILITY, firstInterviewedAt: stale });
      expect(table.row('bgg')?.lastInterviewedAt?.getTime()).toBeGreaterThan(stale.getTime());
    });

    it('runs for a driver handed to register(), as a plugin DataGateway’s will be', async () => {
      table.seed({ id: 'plugin-bgg' });
      const driver = makeDriver({ capabilities: [proto.Capability.CAPABILITY_FETCH] });

      await service.register('plugin-bgg', driver);

      expect(table.row('plugin-bgg')?.capabilities).toEqual([Fetch]);
      await expect(service.resolve('plugin-bgg', Fetch)).resolves.toBe(driver);
    });

    it('keeps a driver handed to register() out of routing when its first interview fails', async () => {
      table.seed({ id: 'plugin-bgg' });
      const driver = failingInterview();

      await expect(service.register('plugin-bgg', driver)).rejects.toBeInstanceOf(GatewayInterviewError);

      expect(driver.disposed).toBe(true);
      expect(service.isConnected('plugin-bgg')).toBe(false);
    });
  });

  describe('resolve', () => {
    it('connects a DataGateway on its first reach, interviews it, and routes it', async () => {
      table.seed({ id: 'bgg' });
      const driver = stubFactory(makeDriver());

      await expect(service.resolve('bgg', Fetch)).resolves.toBe(driver);

      expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: 'bgg', connectionPort: 50051 }));
      expect(table.row('bgg')?.firstInterviewedAt).toEqual(expect.any(Date));
    });

    it('connects an interviewed DataGateway lazily without interviewing it again', async () => {
      interviewedRow('bgg');
      const driver = stubFactory(makeDriver());
      const describe = jest.spyOn(driver, 'describe');

      await expect(service.resolve('bgg', Search)).resolves.toBe(driver);
      await settle();

      expect(describe).not.toHaveBeenCalled();
    });

    it('shares one connect among concurrent callers for the same DataGateway', async () => {
      interviewedRow('bgg');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      factory.create.mockImplementation(async () => {
        await gate;
        return makeDriver();
      });

      const inFlight = Promise.all([service.resolve('bgg', Search), service.resolve('bgg', Fetch)]);
      release();
      await inFlight;

      expect(factory.create).toHaveBeenCalledTimes(1);
    });

    it('refuses a capability the DataGateway doesn’t declare, and doesn’t count it as a failure', async () => {
      interviewedRow('bgg', [Fetch]);
      stubFactory(makeDriver());

      await expect(service.resolve('bgg', Search)).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        reason: 'not_declared',
      });

      for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt++) {
        await expect(service.resolve('bgg', Search)).rejects.toThrow();
      }
      expect(table.row('bgg')?.enabled).toBe(true);
    });

    it('refuses a capability an admin switched off, while routing the rest', async () => {
      interviewedRow('bgg');
      table.patch('bgg', { disabledCapabilities: [Search] });
      const driver = stubFactory(makeDriver());

      await expect(service.resolve('bgg', Search)).rejects.toMatchObject({ reason: 'switched_off' });
      await expect(service.resolve('bgg', Fetch)).resolves.toBe(driver);
    });

    it('refuses a DataGateway an admin disabled, even while this process still holds its driver', async () => {
      interviewedRow('bgg');
      stubFactory(makeDriver());
      await service.connect(connectOpts);

      table.patch('bgg', { enabled: false });

      await expect(service.resolve('bgg', Fetch)).rejects.toMatchObject({ reason: 'disabled' });
    });

    it('refuses a DataGateway that doesn’t exist or was deleted, without connecting', async () => {
      table.seed({ id: 'deleted', deletedAt: new Date() });

      await expect(service.resolve('gone', Search)).rejects.toMatchObject({ reason: 'unknown' });
      await expect(service.resolve('deleted', Search)).rejects.toMatchObject({ reason: 'unknown' });
      expect(factory.create).not.toHaveBeenCalled();
    });

    it('refuses a DataGateway whose first interview failed, and tries again on the next reach', async () => {
      table.seed({ id: 'bgg' });
      factory.create.mockResolvedValueOnce(failingInterview());
      const recovered = makeDriver();
      factory.create.mockResolvedValueOnce(recovered);

      await expect(service.resolve('bgg', Search)).rejects.toBeInstanceOf(GatewayInterviewError);
      await expect(service.resolve('bgg', Search)).resolves.toBe(recovered);
    });

    it('refuses a DataGateway it holds a driver for but whose row shows no first interview', async () => {
      table.seed({ id: 'plugin-bgg' });
      await service.register('plugin-bgg', makeDriver());

      table.patch('plugin-bgg', { firstInterviewedAt: null });

      await expect(service.resolve('plugin-bgg', Search)).rejects.toMatchObject({ reason: 'not_interviewed' });
    });
  });

  describe('routableGatewayIds', () => {
    it('lists the connected DataGateways that may serve the capability, and no others', async () => {
      interviewedRow('searches');
      interviewedRow('fetches-only', [Fetch]);
      interviewedRow('switched-off');
      table.patch('switched-off', { disabledCapabilities: [Search] });
      interviewedRow('disabled');
      interviewedRow('not-connected');

      for (const id of ['searches', 'fetches-only', 'switched-off', 'disabled']) {
        await service.register(id, makeDriver());
      }
      table.patch('disabled', { enabled: false });

      await expect(service.routableGatewayIds(Search)).resolves.toEqual(['searches']);
      await expect(service.routableGatewayIds(Fetch)).resolves.toEqual(['searches', 'fetches-only', 'switched-off']);
    });

    it('lists none while nothing is connected', async () => {
      interviewedRow('bgg');

      await expect(service.routableGatewayIds(Search)).resolves.toEqual([]);
    });

    it('lists, for a filtered search, only those whose coverage overlaps the filter', async () => {
      coveringRow('bgg', TABLETOP_GAMES);
      coveringRow('igdb', VIDEO_GAMES);
      coveringRow('unanswered', { coveragePlatformTypes: [], coverageContentTypes: [] });

      for (const id of ['bgg', 'igdb', 'unanswered']) {
        await service.register(id, makeDriver());
      }

      await expect(service.routableGatewayIds(Search, { platformTypes: new Set([Tabletop]) })).resolves.toEqual([
        'bgg',
      ]);
      await expect(service.routableGatewayIds(Search, { contentTypes: new Set([ContentType.DLC]) })).resolves.toEqual([
        'igdb',
      ]);
      await expect(service.routableGatewayIds(Search, {})).resolves.toEqual(['bgg', 'igdb', 'unanswered']);
    });
  });

  describe('searchRoute', () => {
    it('reads by the row how a search reaches a DataGateway, without connecting it', async () => {
      coveringRow('bgg', TABLETOP_GAMES, [SearchFilterAxis.ContentType]);

      await expect(service.searchRoute('bgg', { platformTypes: new Set([Tabletop]) })).resolves.toEqual({
        routable: true,
        covers: true,
        filterableAxes: [SearchFilterAxis.ContentType],
        contentFormat: null,
        driver: expect.any(Function),
      });
      await expect(service.searchRoute('bgg', { platformTypes: new Set([PlatformType.PC]) })).resolves.toEqual({
        routable: true,
        covers: false,
        filterableAxes: [SearchFilterAxis.ContentType],
        contentFormat: null,
        driver: expect.any(Function),
      });
      expect(factory.create).not.toHaveBeenCalled();
    });

    it('gives a search that must ask the connected driver, without reading the row again', async () => {
      coveringRow('bgg', TABLETOP_GAMES);
      const driver = stubFactory(makeDriver());
      await service.connect(connectOpts);
      await settle();
      const route = await service.searchRoute('bgg', {});
      const reads = jest.spyOn(table.delegate, 'findFirst');

      await expect(route.routable && route.driver()).resolves.toBe(driver);
      expect(reads).not.toHaveBeenCalled();
    });

    it('connects a DataGateway this process hasn’t when a search asks for its route’s driver', async () => {
      coveringRow('bgg', TABLETOP_GAMES);
      const driver = stubFactory(makeDriver());
      const route = await service.searchRoute('bgg', {});

      await expect(route.routable && route.driver()).resolves.toBe(driver);
      expect(service.isConnected('bgg')).toBe(true);
    });

    it('marks a DataGateway that may not search unroutable, whatever its coverage', async () => {
      coveringRow('switched-off', TABLETOP_GAMES);
      table.patch('switched-off', { disabledCapabilities: [Search] });
      table.seed({ id: 'never-interviewed' });

      await expect(service.searchRoute('switched-off', {})).resolves.toEqual({ routable: false });
      await expect(service.searchRoute('never-interviewed', {})).resolves.toEqual({ routable: false });
      await expect(service.searchRoute('gone', {})).resolves.toEqual({ routable: false });
      expect(factory.create).not.toHaveBeenCalled();
    });
  });

  describe('resolveSearch', () => {
    it('resolves a DataGateway whose coverage overlaps the filter, with the axes its search narrows by', async () => {
      coveringRow('bgg', TABLETOP_GAMES, [SearchFilterAxis.ContentType]);
      const driver = stubFactory(makeDriver());

      await expect(service.resolveSearch('bgg', { contentTypes: new Set([ContentType.Expansion]) })).resolves.toEqual({
        driver,
        filterableAxes: [SearchFilterAxis.ContentType],
        contentFormat: null,
      });
    });

    it('answers null for one whose coverage doesn’t overlap the filter, without connecting it', async () => {
      coveringRow('bgg', TABLETOP_GAMES);

      await expect(
        service.resolveSearch('bgg', { platformTypes: new Set([PlatformType.Console]) }),
      ).resolves.toBeNull();
      expect(factory.create).not.toHaveBeenCalled();
    });

    it('refuses a DataGateway that may not search before reading its coverage', async () => {
      coveringRow('bgg', TABLETOP_GAMES);
      table.patch('bgg', { disabledCapabilities: [Search] });

      await expect(
        service.resolveSearch('bgg', { platformTypes: new Set([PlatformType.Console]) }),
      ).rejects.toMatchObject({ name: GatewayRoutingRefusedError.name, reason: 'switched_off' });
    });

    it('interviews a DataGateway never interviewed, and reads the coverage it declared', async () => {
      table.seed({ id: 'bgg' });
      stubFactory(
        makeDriver({
          coverage: {
            platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP],
            contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME],
          },
        }),
      );

      await expect(service.resolveSearch('bgg', { platformTypes: new Set([Tabletop]) })).resolves.toMatchObject({
        filterableAxes: [],
      });
      await expect(service.resolveSearch('bgg', { platformTypes: new Set([PlatformType.PC]) })).resolves.toBeNull();
    });
  });

  describe('the content format', () => {
    it('comes with each route and resolution, from the same read of the row', async () => {
      coveringRow('bgg', TABLETOP_GAMES);
      table.patch('bgg', { contentFormat: ContentFormat.Html });
      const driver = stubFactory(makeDriver());

      await expect(service.searchRoute('bgg', {})).resolves.toMatchObject({ contentFormat: ContentFormat.Html });
      await expect(service.resolveSearch('bgg', {})).resolves.toMatchObject({ contentFormat: ContentFormat.Html });
      await expect(service.resolveWithContentFormat('bgg', FetchExpansions)).resolves.toEqual({
        driver,
        contentFormat: ContentFormat.Html,
      });
    });

    it('is refused with the DataGateway, as resolve refuses it', async () => {
      interviewedRow('bgg');
      table.patch('bgg', { disabledCapabilities: [FetchExpansions] });

      await expect(service.resolveWithContentFormat('bgg', FetchExpansions)).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        reason: 'switched_off',
      });
      expect(factory.create).not.toHaveBeenCalled();
    });
  });

  describe('coverageOverlaps', () => {
    it('overlaps a filter on each axis it names by a value covered there', () => {
      expect(coverageOverlaps(TABLETOP_GAMES, {})).toBe(true);
      expect(coverageOverlaps(TABLETOP_GAMES, { platformTypes: new Set([PlatformType.PC, Tabletop]) })).toBe(true);
      expect(
        coverageOverlaps(TABLETOP_GAMES, {
          platformTypes: new Set([Tabletop]),
          contentTypes: new Set([ContentType.DLC]),
        }),
      ).toBe(false);
    });

    it('covers nothing on an axis whose coverage is empty, or for a filter naming nothing it knows there', () => {
      const unanswered = { coveragePlatformTypes: [], coverageContentTypes: [ContentType.BaseGame] };

      expect(coverageOverlaps(unanswered, { platformTypes: new Set([Tabletop]) })).toBe(false);
      expect(coverageOverlaps(TABLETOP_GAMES, { contentTypes: new Set() })).toBe(false);
    });
  });

  describe('reinterview', () => {
    it('interviews a DataGateway now, however recent its answers', async () => {
      interviewedRow('bgg', [Fetch]);
      stubFactory(makeDriver());
      await service.connect(connectOpts);

      await service.reinterview('bgg');

      expect(table.row('bgg')?.capabilities).toEqual(EVERY_CAPABILITY);
    });

    it('connects a DataGateway this process hasn’t, to interview it', async () => {
      interviewedRow('bgg', [Fetch]);
      stubFactory(makeDriver());

      await service.reinterview('bgg');

      expect(service.isConnected('bgg')).toBe(true);
      expect(table.row('bgg')?.capabilities).toEqual(EVERY_CAPABILITY);
    });

    it('interviews a DataGateway never interviewed once, by connecting it', async () => {
      table.seed({ id: 'bgg' });
      const driver = stubFactory(makeDriver());
      const describe = jest.spyOn(driver, 'describe');

      await service.reinterview('bgg');

      expect(describe).toHaveBeenCalledTimes(1);
      expect(table.row('bgg')?.firstInterviewedAt).toEqual(expect.any(Date));
    });

    // A config change abandons a connect under way, and the connect returns
    // without throwing. For one never interviewed that connect was the
    // interview, so the caller must hear that none happened (#715).
    it('fails for a DataGateway never interviewed when its connect is abandoned', async () => {
      table.seed({ id: 'bgg' });
      const driver = stubFactory(makeDriver());
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const describe = driver.describe.bind(driver);
      driver.describe = (request) => from(answered).pipe(concatMap(() => describe(request)));
      const asked = service.reinterview('bgg');
      await settle();

      await dispatch({ gatewayId: 'bgg', configHash: 'x', changeType: 'updated', timestamp: 0 });
      answer();

      await expect(asked).rejects.toThrow(/abandoned/);
      expect(service.isConnected('bgg')).toBe(false);
    });

    it('refuses a disabled DataGateway', async () => {
      interviewedRow('bgg');
      table.patch('bgg', { enabled: false });
      stubFactory(makeDriver());

      await expect(service.reinterview('bgg')).rejects.toMatchObject({
        name: GatewayRoutingRefusedError.name,
        reason: 'disabled',
      });
      expect(factory.create).not.toHaveBeenCalled();
    });
  });

  describe('refreshInterview', () => {
    it('interviews a connected DataGateway again when it reports a version other than the stored one', async () => {
      interviewedRow('bgg', [Fetch]);
      stubFactory(makeDriver());
      await service.connect(connectOpts);
      await settle();
      table.patch('bgg', { gatewayVersion: '0.0.0-older' });

      await service.refreshInterview('bgg');

      expect(table.row('bgg')).toMatchObject({ gatewayVersion: IN_MEMORY_VERSION, capabilities: EVERY_CAPABILITY });
    });

    it('leaves a DataGateway this process hasn’t connected alone', async () => {
      interviewedRow('bgg');

      await expect(service.refreshInterview('bgg')).resolves.toBeUndefined();
      expect(factory.create).not.toHaveBeenCalled();
    });
  });

  describe('register', () => {
    it('routes a driver handed to it without the remote factory', async () => {
      table.seed({ id: 'plugin-bgg' });
      const driver = makeDriver({ gatewayName: 'in-proc' });

      await service.register('plugin-bgg', driver);

      await expect(service.resolve('plugin-bgg', Search)).resolves.toBe(driver);
      expect(factory.create).not.toHaveBeenCalled();
      expect(service.isConnected('plugin-bgg')).toBe(true);
    });

    it('disconnect disposes a registered driver', async () => {
      table.seed({ id: 'plugin-bgg' });
      const driver = makeDriver();
      await service.register('plugin-bgg', driver);

      service.disconnect('plugin-bgg');

      expect(driver.disposed).toBe(true);
      expect(service.isConnected('plugin-bgg')).toBe(false);
    });

    it('disposes an evicted driver when a new one is registered under the same id', async () => {
      table.seed({ id: 'bgg' });
      const evicted = makeDriver();
      await service.register('bgg', evicted);
      const replacement = makeDriver();

      await service.register('bgg', replacement);

      // No leaked channel: the displaced driver is torn down, the new one kept.
      expect(evicted.dispose).toHaveBeenCalledTimes(1);
      expect(replacement.dispose).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('keeps serving its drivers through onModuleDestroy, while the server still takes requests', async () => {
      interviewedRow('bgg');
      const driver = makeDriver();
      await service.register('bgg', driver);

      await service.onModuleDestroy();

      expect(driver.dispose).not.toHaveBeenCalled();
      await expect(service.resolve('bgg', Search)).resolves.toBe(driver);
    });

    it('disposes every driver on onApplicationShutdown', async () => {
      interviewedRow('bgg');
      const driver = makeDriver();
      await service.register('bgg', driver);

      await service.onApplicationShutdown();

      expect(driver.dispose).toHaveBeenCalledTimes(1);
      expect(service.isConnected('bgg')).toBe(false);
    });

    it('disposes a driver whose connect finishes after shutdown, instead of caching it', async () => {
      interviewedRow('bgg');
      const driver = makeDriver();
      let finishPing!: (driver: DataGatewayDriver) => void;
      factory.create.mockReturnValue(new Promise<DataGatewayDriver>((resolve) => (finishPing = resolve)));

      const connecting = service.connect(connectOpts);
      await service.onApplicationShutdown();
      finishPing(driver);
      await connecting;

      expect(driver.dispose).toHaveBeenCalledTimes(1);
      expect(service.isConnected('bgg')).toBe(false);
    });
  });

  // Regression: an eager bootstrap connect and a job-triggered lazy resolve for
  // the same gateway race. Neither should leak — whichever driver loses the
  // cache slot must be disposed. Ordering-agnostic on purpose (last write by
  // completion order wins; we assert only the no-leak invariant).
  describe('concurrent connect race (no leak)', () => {
    it('disposes exactly the driver that loses the cache slot', async () => {
      table.seed({ id: 'bgg' });
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

      const lazy = service.resolve('bgg', Search); // factory call #1 (gated → a)
      const explicit = service.connect(connectOpts); // factory call #2 → b
      release();
      await Promise.all([lazy, explicit]);

      const survivor = await service.resolve('bgg', Search);
      const evicted = survivor === a ? b : a;
      expect(evicted.dispose).toHaveBeenCalledTimes(1);
      expect(survivor.dispose).not.toHaveBeenCalled();
    });
  });

  describe('connect (mid-connect invalidation race)', () => {
    it('discards the freshly-connected driver when a disable event arrives during the ping', async () => {
      interviewedRow('bgg');
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

    it('discards the freshly-connected driver when a disable event arrives during its first interview', async () => {
      table.seed({ id: 'bgg' });
      const driver = stubFactory(makeDriver());

      // Hold Describe open, so the disable event lands mid-interview.
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const describe = driver.describe.bind(driver);
      driver.describe = (request) => from(answered).pipe(concatMap(() => describe(request)));

      const connecting = service.connect(connectOpts);
      await settle();
      await dispatch({ gatewayId: 'bgg', configHash: '', changeType: 'disabled', timestamp: 0 });

      answer();
      await connecting;

      expect(service.isConnected('bgg')).toBe(false);
      expect(driver.dispose).toHaveBeenCalledTimes(1);
      // The interview was abandoned with the connect, so it stored nothing.
      expect(table.row('bgg')?.firstInterviewedAt).toBeNull();
    });

    it('discards the freshly-connected driver when a config-change event arrives during the ping', async () => {
      interviewedRow('bgg');
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
      interviewedRow('bgg');
      const driver = stubFactory(makeDriver());

      await service.connect(connectOpts);

      expect(service.isConnected('bgg')).toBe(true);
      expect(driver.dispose).not.toHaveBeenCalled();
    });

    it('feeds connection failures into failure tracking and rethrows', async () => {
      table.seed({ id: 'bgg' });
      factory.create.mockRejectedValue(new Error('unreachable'));

      for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt++) {
        await expect(service.connect(connectOpts)).rejects.toThrow('unreachable');
      }

      expect(service.isConnected('bgg')).toBe(false);
      expect(table.row('bgg')?.enabled).toBe(false);
    });
  });

  describe('an interview under way when its driver is let go', () => {
    it('is abandoned when a config event replaces the driver, so the reconnect interviews afresh and isn’t overwritten', async () => {
      const stale = new Date(Date.now() - 2 * DAY);
      table.seed({
        id: 'bgg',
        capabilities: [Fetch],
        gatewayVersion: IN_MEMORY_VERSION,
        firstInterviewedAt: stale,
        lastInterviewedAt: stale,
      });
      // The old endpoint declares Search and Fetch, and holds back its answer to Describe.
      const old = makeDriver({ capabilities: [proto.Capability.CAPABILITY_SEARCH, proto.Capability.CAPABILITY_FETCH] });
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const describe = old.describe.bind(old);
      old.describe = (request) => from(answered).pipe(concatMap(() => describe(request)));
      stubFactory(old);
      await service.connect(connectOpts);
      await settle(); // The connect's re-interview now waits on the old endpoint.

      await dispatch({ gatewayId: 'bgg', configHash: 'new-hash', changeType: 'updated', timestamp: 0 });
      stubFactory(makeDriver());
      await service.resolve('bgg', Fetch);
      await settle();
      answer();
      await settle();

      expect(table.row('bgg')).toMatchObject({ capabilities: EVERY_CAPABILITY, lastInterviewFailure: null });
    });

    it('is abandoned when its driver is disposed, as on a reconnect, and fails for whoever waits on it', async () => {
      interviewedRow('bgg');
      const old = stubFactory(makeDriver());
      await service.connect(connectOpts);
      await settle();
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const describe = old.describe.bind(old);
      old.describe = (request) => from(answered).pipe(concatMap(() => describe(request)));
      const asked = service.reinterview('bgg');
      await settle();

      stubFactory(makeDriver());
      await dispatch({ gatewayId: 'bgg', configHash: 'x', changeType: 'reconnect-requested', timestamp: 0 });
      answer();

      await expect(asked).rejects.toThrow(/abandoned/);
      expect(table.row('bgg')?.lastInterviewFailure).toBeNull();
    });
  });

  describe('handleConfigUpdate', () => {
    it('reconnect-requested drops the existing REMOTE driver and eagerly reconnects', async () => {
      // Seed a remote-origin cached driver by driving a real connect() first.
      // register() would tag it 'registered', which handleConfigUpdate now
      // intentionally exempts from reconnect events (see the in-process test
      // below) — reconnect only applies to remote connections.
      interviewedRow('bgg');
      const oldDriver = stubFactory(makeDriver());
      await service.connect(connectOpts); // origin: 'remote'
      expect(service.isConnected('bgg')).toBe(true);

      stubFactory(makeDriver());

      await dispatch({ gatewayId: 'bgg', configHash: 'x', changeType: 'reconnect-requested', timestamp: 0 });

      expect(oldDriver.dispose).toHaveBeenCalledTimes(1);
      // Two creates: the seed connect above + the eager reconnect.
      expect(factory.create).toHaveBeenCalledTimes(2);
      expect(service.isConnected('bgg')).toBe(true);
    });

    it('has the next connect interview again after the connection changes, whatever the answers’ age and version', async () => {
      interviewedRow('bgg', [Fetch]);
      stubFactory(makeDriver({ capabilities: [proto.Capability.CAPABILITY_FETCH] }));
      await service.connect(connectOpts);
      await settle();

      // An admin points the row at another DataGateway, which reports the same version.
      await dispatch({ gatewayId: 'bgg', configHash: 'new-hash', changeType: 'updated', timestamp: 0 });
      stubFactory(makeDriver());
      await service.resolve('bgg', Fetch);
      await settle();

      expect(table.row('bgg')?.capabilities).toEqual(EVERY_CAPABILITY);
    });

    it('ignores updated/reconnect-requested for registered in-process drivers', async () => {
      interviewedRow('plugin-bgg');
      const driver = makeDriver();
      await service.register('plugin-bgg', driver);

      await dispatch({ gatewayId: 'plugin-bgg', configHash: 'h', changeType: 'updated', timestamp: 0 });
      await dispatch({ gatewayId: 'plugin-bgg', configHash: 'h', changeType: 'reconnect-requested', timestamp: 0 });

      // The plugin driver survives and connectFromDb is never consulted — an
      // in-process driver must not be silently swapped for a remote one.
      expect(driver.disposed).toBe(false);
      expect(service.isConnected('plugin-bgg')).toBe(true);
      expect(factory.create).not.toHaveBeenCalled();
    });

    it('still tears down a registered driver on disabled (admin intent wins)', async () => {
      interviewedRow('plugin-bgg');
      const driver = makeDriver();
      await service.register('plugin-bgg', driver);

      await dispatch({ gatewayId: 'plugin-bgg', configHash: '', changeType: 'disabled', timestamp: 0 });

      expect(driver.disposed).toBe(true);
      expect(service.isConnected('plugin-bgg')).toBe(false);
    });

    it('reconnect-requested swallows reconnect failures (no throw out of the handler)', async () => {
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

    it('leaves the DataGateway enabled below the failure threshold', async () => {
      table.seed({ id: 'bgg' });

      await service.reportFailure('bgg', new Error('boom'));

      expect(table.row('bgg')?.enabled).toBe(true);
    });

    it('disables the gateway inside a system actor scope and emits a GatewayDisabledEvent', async () => {
      table.seed({ id: 'bgg' });
      const emitSpy = jest.spyOn(emitter, 'emit');

      await failUntilThreshold();

      expect(table.row('bgg')?.enabled).toBe(false);
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

    it('logs the auto-disable without claiming a notification, which the listener sends (#763)', async () => {
      table.seed({ id: 'bgg' });
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await failUntilThreshold();

      expect(error).toHaveBeenCalledWith(
        `DataGateway bgg auto-disabled after ${FAILURE_THRESHOLD} consecutive failures (reason=repeated_call_failure).`,
      );
    });

    it('does not emit when another process already disabled the gateway', async () => {
      table.seed({ id: 'bgg', enabled: false });
      const emitSpy = jest.spyOn(emitter, 'emit');

      await failUntilThreshold();

      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('logs a lost race without claiming a notification, which only the winner’s listener sends (#763)', async () => {
      table.seed({ id: 'bgg', enabled: false });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await failUntilThreshold();

      expect(warn).toHaveBeenCalledWith(
        'DataGateway bgg was already off (another process auto-disabled it, or a server admin switched it off); emitting nothing.',
      );
    });

    it('is transport-agnostic: a registered in-process driver trips the same threshold and is disposed on disable', async () => {
      interviewedRow('plugin-bgg');
      const driver = makeDriver();
      await service.register('plugin-bgg', driver);
      driver.failWith(new Error('in-proc boom'));

      await failUntilThreshold('plugin-bgg');

      expect(table.row('plugin-bgg')?.enabled).toBe(false);
      expect(driver.disposed).toBe(true);
      expect(service.isConnected('plugin-bgg')).toBe(false);
    });
  });
});
