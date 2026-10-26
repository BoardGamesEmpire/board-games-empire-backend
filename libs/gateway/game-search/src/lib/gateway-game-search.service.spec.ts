import { ContentFormat, ContentType, DataGatewayCapability, PlatformType, SearchFilterAxis } from '@bge/database';
import {
  coverageOverlaps,
  GatewayRegistryService,
  GatewayRoutingRefusedError,
  type CoverageFilter,
  type GatewayResolution,
  type SearchResolution,
  type SearchRoute,
  type StoredCoverage,
} from '@bge/gateway-registry';
import { createTestingModuleWithDb, type CacheMock, type MockDatabaseService } from '@bge/testing';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { from, lastValueFrom, toArray, type Observable } from 'rxjs';
import { GatewayGameSearchService } from './gateway-game-search.service';

const {
  RESULT_STATUS_RESULT: RESULT,
  RESULT_STATUS_SOURCE_DONE: SOURCE_DONE,
  RESULT_STATUS_ERROR: ERROR,
  RESULT_STATUS_UNAVAILABLE: UNAVAILABLE,
  RESULT_STATUS_RATE_LIMITED: RATE_LIMITED,
  RESULT_STATUS_UNFILTERABLE: UNFILTERABLE,
  RESULT_STATUS_UNSPECIFIED: UNSPECIFIED,
} = proto.ResultStatus;

const searchHit = (externalId: string, title: string): proto.GameSearchData => ({
  externalId,
  title,
  contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  availablePlatforms: [],
  availableReleases: [],
});

const catan = searchHit('13', 'Catan');
const brass = searchHit('224517', 'Brass: Birmingham');
const halo = searchHit('740', 'Halo: Combat Evolved');

const { PLATFORM_TYPE_TABLETOP: TABLETOP, PLATFORM_TYPE_PC: PC } = proto.PlatformType;
const { CONTENT_TYPE_BASE_GAME: BASE_GAME, CONTENT_TYPE_EXPANSION: EXPANSION } = proto.ContentType;

/** A search hit on a single platform of `platformType`. */
const hitOn = (
  externalId: string,
  contentType: proto.ContentType,
  platformType: proto.PlatformType,
): proto.GameSearchData => ({
  ...searchHit(externalId, externalId),
  contentType,
  availablePlatforms: [{ externalId: platformType, name: platformType, platformType }],
});

const tabletopCatan = hitOn('catan', BASE_GAME, TABLETOP);
const seafarers = hitOn('seafarers', EXPANSION, TABLETOP);
const catanOnPc = hitOn('catan-pc', BASE_GAME, PC);

/** A hit whose content type its DataGateway couldn't tell, on no platform it named. */
const unclassified: proto.GameSearchData = {
  ...searchHit('unclassified', 'Unclassified'),
  contentType: proto.ContentType.CONTENT_TYPE_UNSPECIFIED,
};

interface ScriptedStreams {
  searchGames?: proto.GatewaySearchResult[];
  fetchExpansions?: proto.GatewaySearchResult[];
}

/** A driver whose streams are exactly the given frames, for statuses the fixture-backed driver never produces. */
const scriptedDriver = ({ searchGames = [], fetchExpansions = [] }: ScriptedStreams): DataGatewayDriver =>
  Object.assign(new InMemoryGatewayDriver(), {
    searchGames: () => from(searchGames),
    fetchExpansions: () => from(fetchExpansions),
  });

const EVERY_CAPABILITY = Object.values(DataGatewayCapability);

/** Covers every kind of game, so a filter never skips it. */
const EVERYTHING: StoredCoverage = {
  coveragePlatformTypes: Object.values(PlatformType),
  coverageContentTypes: Object.values(ContentType),
};

const TABLETOP_GAMES: StoredCoverage = {
  coveragePlatformTypes: [PlatformType.Tabletop],
  coverageContentTypes: [ContentType.BaseGame, ContentType.Expansion],
};

const VIDEO_GAMES: StoredCoverage = {
  coveragePlatformTypes: [PlatformType.Console, PlatformType.PC],
  coverageContentTypes: [ContentType.BaseGame, ContentType.DLC],
};

interface Registration {
  driver: DataGatewayDriver;
  capabilities: DataGatewayCapability[];
  coverage: StoredCoverage;
  filterableAxes: SearchFilterAxis[];
  contentFormat: ContentFormat | null;
}

/**
 * Stands in for GatewayRegistryService with the calls the service makes,
 * typed against the real ones so the two cannot drift apart, and judging
 * coverage by the real rule. Like the real gateway registry, `resolve` and
 * `resolveSearch` reject for a DataGateway it cannot produce a driver for,
 * and refuse a capability the DataGateway may not serve before reading its
 * coverage; only registered DataGateways count as connected. `resolved`
 * lists each DataGateway whose driver was taken, however it was.
 */
class FakeRegistry implements Pick<
  GatewayRegistryService,
  'resolve' | 'resolveWithContentFormat' | 'resolveSearch' | 'routableGatewayIds' | 'searchRoute'
> {
  readonly resolved: string[] = [];
  private readonly drivers = new Map<string, Registration>();

  /**
   * Connects a DataGateway that may serve `capabilities`, every one unless
   * given, and that covers every kind of game, narrows by no axis and sends
   * plain text, unless its answers say otherwise.
   */
  register(
    gatewayId: string,
    driver: DataGatewayDriver,
    capabilities = EVERY_CAPABILITY,
    answers: Partial<Pick<Registration, 'coverage' | 'filterableAxes' | 'contentFormat'>> = {},
  ): this {
    this.drivers.set(gatewayId, {
      driver,
      capabilities,
      coverage: EVERYTHING,
      filterableAxes: [],
      contentFormat: ContentFormat.PlainText,
      ...answers,
    });
    return this;
  }

  async routableGatewayIds(capability: DataGatewayCapability, filter: CoverageFilter = {}): Promise<string[]> {
    return [...this.drivers]
      .filter(
        ([, { capabilities, coverage }]) => capabilities.includes(capability) && coverageOverlaps(coverage, filter),
      )
      .map(([id]) => id);
  }

  async searchRoute(gatewayId: string, filter: CoverageFilter): Promise<SearchRoute> {
    const connected = this.drivers.get(gatewayId);
    if (!connected?.capabilities.includes(DataGatewayCapability.Search)) {
      return { routable: false };
    }

    return {
      routable: true,
      covers: coverageOverlaps(connected.coverage, filter),
      filterableAxes: connected.filterableAxes,
      contentFormat: connected.contentFormat,
      driver: async () => {
        this.resolved.push(gatewayId);
        return connected.driver;
      },
    };
  }

  async resolve(gatewayId: string, capability: DataGatewayCapability): Promise<DataGatewayDriver> {
    return this.routed(gatewayId, capability).driver;
  }

  async resolveWithContentFormat(gatewayId: string, capability: DataGatewayCapability): Promise<GatewayResolution> {
    const { driver, contentFormat } = this.routed(gatewayId, capability);

    return { driver, contentFormat };
  }

  async resolveSearch(gatewayId: string, filter: CoverageFilter): Promise<SearchResolution | null> {
    const { driver, coverage, filterableAxes, contentFormat } = this.routed(gatewayId, DataGatewayCapability.Search);

    return coverageOverlaps(coverage, filter) ? { driver, filterableAxes, contentFormat } : null;
  }

  private routed(gatewayId: string, capability: DataGatewayCapability): Registration {
    this.resolved.push(gatewayId);

    const connected = this.drivers.get(gatewayId);
    if (!connected) {
      throw new Error(`No connection established for gateway ${gatewayId}.`);
    }

    if (!connected.capabilities.includes(capability)) {
      throw new GatewayRoutingRefusedError(gatewayId, 'not_declared', capability);
    }

    return connected;
  }
}

/** The dedup lookup's argument: a GameSource by its (gateway, external id) key. */
interface SourceLookup {
  where: { gatewayId_externalId: { gatewayId: string; externalId: string } };
}

const collect = <T>(stream: Observable<T>): Promise<T[]> => lastValueFrom(stream.pipe(toArray()));

const searchRequest = (overrides: Partial<proto.SearchGamesRequest> = {}): proto.SearchGamesRequest => ({
  correlationId: 'corr-1',
  query: 'catan',
  gatewayIds: [],
  ...overrides,
});

describe('GatewayGameSearchService', () => {
  let service: GatewayGameSearchService;
  let db: MockDatabaseService;
  let cache: CacheMock;
  let registry: FakeRegistry;

  /** Games already imported, keyed `${gatewayId}:${externalId}` → local Game.id. */
  let imported: Map<string, string>;

  beforeEach(async () => {
    registry = new FakeRegistry();
    imported = new Map();

    const ctx = await createTestingModuleWithDb({
      providers: [GatewayGameSearchService, { provide: GatewayRegistryService, useValue: registry }],
    });

    service = ctx.module.get(GatewayGameSearchService);
    db = ctx.db;
    cache = ctx.cache;

    db.gameSource.findUnique.mockImplementation((async ({ where }: SourceLookup) => {
      const { gatewayId, externalId } = where.gatewayId_externalId;
      const gameId = imported.get(`${gatewayId}:${externalId}`);
      return gameId ? { gameId } : null;
    }) as never);

    const store = new Map<string, unknown>();
    cache.get.mockImplementation((async (key: string) => store.get(key)) as never);
    cache.set.mockImplementation((async (key: string, value: unknown) => {
      store.set(key, value);
      return value;
    }) as never);
  });

  describe('searchGames', () => {
    it('sends an untargeted search to every connected DataGateway that may search, each closing with its own SOURCE_DONE', async () => {
      registry
        .register('bgg', new InMemoryGatewayDriver({ searchResults: [catan, brass] }))
        .register('igdb', new InMemoryGatewayDriver({ searchResults: [halo] }));

      const frames = await collect(service.searchGames(searchRequest()));

      expect(frames.filter((frame) => frame.gatewayId === 'bgg')).toEqual([
        expect.objectContaining({ status: RESULT, game: catan }),
        expect.objectContaining({ status: RESULT, game: brass }),
        { correlationId: 'corr-1', gatewayId: 'bgg', status: SOURCE_DONE },
      ]);
      expect(frames.filter((frame) => frame.gatewayId === 'igdb')).toEqual([
        expect.objectContaining({ status: RESULT, game: halo }),
        { correlationId: 'corr-1', gatewayId: 'igdb', status: SOURCE_DONE },
      ]);
    });

    it('marks a hit already imported from that gateway as in the system, with its local game id', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan, brass] }));
      imported.set('bgg:13', 'game-catan');

      const frames = await collect(service.searchGames(searchRequest()));

      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ game: catan, inSystem: true, gameId: 'game-catan' }),
          expect.objectContaining({ game: brass, inSystem: false, gameId: undefined }),
        ]),
      );
    });

    it('searches only the valid ids of a targeted request, never a blank one', async () => {
      registry
        .register('bgg', new InMemoryGatewayDriver({ searchResults: [catan] }))
        .register('igdb', new InMemoryGatewayDriver({ searchResults: [halo] }));

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['bgg', ''] })));

      expect(registry.resolved).toEqual(['bgg']);
      expect(new Set(frames.map((frame) => frame.gatewayId))).toEqual(new Set(['bgg']));
    });

    it('treats a targeted request whose ids are all blank as an empty search, not a search of everything', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan] }));

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: [''] })));

      expect(frames).toEqual([]);
      expect(registry.resolved).toEqual([]);
    });

    it('completes empty when nothing is targeted and no gateway is connected', async () => {
      await expect(collect(service.searchGames(searchRequest()))).resolves.toEqual([]);
    });

    it('leaves a connected DataGateway that may not search out of an untargeted search', async () => {
      registry
        .register('bgg', new InMemoryGatewayDriver({ searchResults: [catan] }))
        .register('enricher', new InMemoryGatewayDriver({ searchResults: [halo] }), [DataGatewayCapability.Fetch]);

      const frames = await collect(service.searchGames(searchRequest()));

      expect(registry.resolved).toEqual(['bgg']);
      expect(new Set(frames.map((frame) => frame.gatewayId))).toEqual(new Set(['bgg']));
    });

    it('answers a named DataGateway that may not search as UNAVAILABLE, saying why', async () => {
      registry.register('enricher', new InMemoryGatewayDriver({ searchResults: [halo] }), [
        DataGatewayCapability.Fetch,
      ]);

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['enricher'] })));

      expect(frames).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'enricher',
          status: UNAVAILABLE,
          message: `DataGateway enricher doesn't declare Search`,
        },
      ]);
    });

    it('reports a gateway it cannot reach as UNAVAILABLE while the others still answer', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan] }));

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['bgg', 'steam'] })));

      expect(frames.filter((frame) => frame.gatewayId === 'steam')).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'steam',
          status: UNAVAILABLE,
          message: 'DataGateway steam is not connected',
        },
      ]);
      expect(frames).toContainEqual(expect.objectContaining({ gatewayId: 'bgg', status: SOURCE_DONE }));
    });

    it('searches live when its route can’t be read, and answers UNAVAILABLE without the database’s error when that fails too', async () => {
      const outage = new Error("Can't reach database server at db:5432");
      registry
        .register('bgg', new InMemoryGatewayDriver({ searchResults: [catan] }))
        .register('igdb', new InMemoryGatewayDriver({ searchResults: [halo] }));
      jest.spyOn(registry, 'searchRoute').mockRejectedValue(outage);
      jest.spyOn(registry, 'resolveSearch').mockImplementation(async (gatewayId, filter) => {
        if (gatewayId === 'igdb') {
          throw outage;
        }
        return FakeRegistry.prototype.resolveSearch.call(registry, gatewayId, filter);
      });

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['bgg', 'igdb'] })));

      expect(frames.filter((frame) => frame.gatewayId === 'bgg')).toEqual([
        expect.objectContaining({ status: RESULT, game: catan }),
        { correlationId: 'corr-1', gatewayId: 'bgg', status: SOURCE_DONE },
      ]);
      expect(frames.filter((frame) => frame.gatewayId === 'igdb')).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'igdb',
          status: UNAVAILABLE,
          message: 'DataGateway igdb is not connected',
        },
      ]);
    });

    it('reports a gateway whose stream fails as ERROR with the failure, distinct from unreachable', async () => {
      const failing = new InMemoryGatewayDriver({ searchResults: [catan] });
      failing.failWith(new Error('upstream exploded'));
      registry.register('bgg', failing);

      const frames = await collect(service.searchGames(searchRequest()));

      expect(frames).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          status: ERROR,
          message: 'upstream exploded',
        },
      ]);
    });

    it('relays a gateway’s status frames with their messages, and drops a RESULT frame that carries no game', async () => {
      registry.register(
        'bgg',
        scriptedDriver({
          searchGames: [
            { correlationId: 'corr-1', status: RESULT },
            { correlationId: 'corr-1', status: RATE_LIMITED, message: 'slow down', retryAfter: 30 },
            { correlationId: 'corr-1', status: UNAVAILABLE, message: 'down for maintenance' },
            { correlationId: 'corr-1', status: ERROR, message: 'bad query' },
          ],
        }),
      );

      const frames = await collect(service.searchGames(searchRequest()));

      expect(frames).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          status: RATE_LIMITED,
          message: 'slow down',
          retryAfter: 30,
        },
        {
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          status: UNAVAILABLE,
          message: 'down for maintenance',
        },
        {
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          status: ERROR,
          message: 'bad query',
        },
      ]);
    });

    it('reports a frame whose status it does not recognize as an ERROR', async () => {
      registry.register('bgg', scriptedDriver({ searchGames: [{ correlationId: 'corr-1', status: UNSPECIFIED }] }));

      const frames = await collect(service.searchGames(searchRequest()));

      expect(frames).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          status: ERROR,
          message: 'Unknown status RESULT_STATUS_UNSPECIFIED',
        },
      ]);
    });

    it('ends a gateway’s results with its own ERROR frame when a dedup lookup fails, and caches none of them', async () => {
      // ERROR, like SOURCE_DONE, closes that gateway's part of the stream, so
      // it names the gateway rather than the no-gateway sentinel.
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan, brass] }));
      db.gameSource.findUnique.mockImplementation((async ({ where }: SourceLookup) => {
        if (where.gatewayId_externalId.externalId === brass.externalId) {
          throw new Error('connection pool exhausted');
        }
        return null;
      }) as never);

      const frames = await collect(service.searchGames(searchRequest()));
      registry.resolved.length = 0;
      await collect(service.searchGames(searchRequest()));

      expect(frames).toEqual([
        expect.objectContaining({ status: RESULT, game: catan }),
        {
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          status: ERROR,
          message: 'connection pool exhausted',
        },
      ]);
      expect(registry.resolved).toEqual(['bgg']);
    });

    it('never lets SOURCE_DONE overtake RESULT frames whose dedup lookups are still in flight', async () => {
      // SOURCE_DONE maps synchronously while each RESULT waits on a lookup, so
      // anything but in-order mapping lets a consumer finalize the source early.
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan, brass] }));
      db.gameSource.findUnique.mockImplementation((() => delay(5).then(() => null)) as never);

      const frames = await collect(service.searchGames(searchRequest()));

      expect(frames.map((frame) => [frame.status, frame.game?.externalId])).toEqual([
        [RESULT, '13'],
        [RESULT, '224517'],
        [SOURCE_DONE, undefined],
      ]);
    });
  });

  describe('searchGames filter', () => {
    const tabletopOnly: proto.SearchFilter = { platformTypes: [TABLETOP], contentTypes: [] };

    /** The searches a driver was sent. */
    const sentTo = (driver: InMemoryGatewayDriver) => jest.spyOn(driver, 'searchGames');

    const games = (frames: proto.SearchGameResult[]) => frames.flatMap((frame) => (frame.game ? [frame.game] : []));

    it('leaves a DataGateway whose coverage doesn’t overlap the filter out of an untargeted search', async () => {
      registry
        .register('bgg', new InMemoryGatewayDriver({ searchResults: [tabletopCatan] }), EVERY_CAPABILITY, {
          coverage: TABLETOP_GAMES,
        })
        .register('igdb', new InMemoryGatewayDriver({ searchResults: [catanOnPc] }), EVERY_CAPABILITY, {
          coverage: VIDEO_GAMES,
        });

      const frames = await collect(service.searchGames(searchRequest({ filter: tabletopOnly })));

      expect(registry.resolved).toEqual(['bgg']);
      expect(new Set(frames.map((frame) => frame.gatewayId))).toEqual(new Set(['bgg']));
    });

    it('answers a named DataGateway whose coverage doesn’t overlap the filter with SOURCE_DONE alone, without asking it', async () => {
      const igdb = new InMemoryGatewayDriver({ searchResults: [catanOnPc] });
      registry.register('igdb', igdb, EVERY_CAPABILITY, { coverage: VIDEO_GAMES });
      const searched = sentTo(igdb);

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['igdb'], filter: tabletopOnly })));

      expect(frames).toEqual([{ correlationId: 'corr-1', gatewayId: 'igdb', status: SOURCE_DONE }]);
      expect(searched).not.toHaveBeenCalled();
    });

    it('answers a named DataGateway that may not search as UNAVAILABLE, saying why, whatever its coverage', async () => {
      registry.register('igdb', new InMemoryGatewayDriver(), [DataGatewayCapability.Fetch], { coverage: VIDEO_GAMES });

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['igdb'], filter: tabletopOnly })));

      expect(frames).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'igdb',
          status: UNAVAILABLE,
          message: `DataGateway igdb doesn't declare Search`,
        },
      ]);
    });

    it('sends a DataGateway the filter on the axes its search narrows by alone, each value once', async () => {
      const bgg = new InMemoryGatewayDriver({ searchResults: [tabletopCatan] });
      registry.register('bgg', bgg, EVERY_CAPABILITY, {
        coverage: TABLETOP_GAMES,
        filterableAxes: [SearchFilterAxis.ContentType],
      });
      const searched = sentTo(bgg);

      await collect(
        service.searchGames(
          searchRequest({ filter: { platformTypes: [TABLETOP], contentTypes: [EXPANSION, BASE_GAME, EXPANSION] } }),
        ),
      );

      expect(searched).toHaveBeenCalledWith(
        expect.objectContaining({ filter: { platformTypes: [], contentTypes: [BASE_GAME, EXPANSION] } }),
      );
    });

    it('sends no filter to a DataGateway whose search narrows by none of the filter’s axes', async () => {
      const bgg = new InMemoryGatewayDriver({ searchResults: [tabletopCatan] });
      registry.register('bgg', bgg, EVERY_CAPABILITY, {
        coverage: TABLETOP_GAMES,
        filterableAxes: [SearchFilterAxis.ContentType],
      });
      const searched = sentTo(bgg);

      await collect(service.searchGames(searchRequest({ filter: tabletopOnly })));

      expect(searched.mock.calls[0]?.[0]).not.toHaveProperty('filter');
    });

    it('removes every result the filter excludes, however the DataGateway narrowed', async () => {
      // It declares content type but ignores the filter, as a loose upstream might.
      registry.register(
        'loose',
        new InMemoryGatewayDriver({ searchResults: [tabletopCatan, seafarers, catanOnPc, unclassified] }),
        EVERY_CAPABILITY,
        { filterableAxes: [SearchFilterAxis.ContentType] },
      );

      const frames = await collect(
        service.searchGames(searchRequest({ filter: { platformTypes: [TABLETOP], contentTypes: [BASE_GAME] } })),
      );

      expect(games(frames)).toEqual([tabletopCatan]);
      expect(frames.at(-1)).toEqual({ correlationId: 'corr-1', gatewayId: 'loose', status: SOURCE_DONE });
    });

    it('never matches a value the DataGateway left unknown, nor a game sent without platforms', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [tabletopCatan, unclassified] }));

      const byContent = await collect(
        service.searchGames(searchRequest({ filter: { platformTypes: [], contentTypes: [BASE_GAME] } })),
      );
      const byPlatform = await collect(service.searchGames(searchRequest({ filter: tabletopOnly })));

      expect(games(byContent)).toEqual([tabletopCatan]);
      expect(games(byPlatform)).toEqual([tabletopCatan]);
    });

    // A publish year narrows but never skips a DataGateway: none declares which
    // years it covers (#719).
    describe('by publish year', () => {
      const dated = (externalId: string, yearPublished?: number): proto.GameSearchData => ({
        ...searchHit(externalId, externalId),
        yearPublished,
      });

      const byYear = (publishYear: proto.IntRange): proto.SearchFilter => ({
        platformTypes: [],
        contentTypes: [],
        publishYear,
      });

      const [old, nineties, recent, undated] = [
        dated('old', 1989),
        dated('nineties', 1995),
        dated('recent', 2010),
        dated('undated'),
      ];

      it('removes every result outside the publish-year range, on the live path and on replay', async () => {
        // It narrows by nothing, so it's asked one search for both and the year applies on the way out.
        registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [old, nineties, undated] }));

        const live = await collect(service.searchGames(searchRequest({ filter: byYear({ min: 1990, max: 2000 }) })));
        registry.resolved.length = 0;
        const replay = await collect(
          service.searchGames(searchRequest({ filter: byYear({ max: 1989, includeUnknown: true }) })),
        );

        expect(games(live)).toEqual([nineties]);
        expect(registry.resolved).toEqual([]);
        expect(games(replay)).toEqual([old, undated]);
      });

      it('sends the range to a DataGateway that narrows by publish year', async () => {
        const bgg = new InMemoryGatewayDriver({ searchResults: [recent] });
        registry.register('bgg', bgg, EVERY_CAPABILITY, { filterableAxes: [SearchFilterAxis.PublishYear] });
        const searched = sentTo(bgg);

        await collect(service.searchGames(searchRequest({ filter: byYear({ min: 2000, includeUnknown: false }) })));

        expect(searched).toHaveBeenCalledWith(
          expect.objectContaining({ filter: { platformTypes: [], contentTypes: [], publishYear: { min: 2000 } } }),
        );
      });

      // One that narrows upstream leaves undated games out of a strict search's
      // answer, so a loose search replaying that entry would never see them.
      it('keys a search that keeps unknown publish years apart from one that doesn’t', async () => {
        registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [undated] }), EVERY_CAPABILITY, {
          filterableAxes: [SearchFilterAxis.PublishYear],
        });

        await collect(service.searchGames(searchRequest({ filter: byYear({ min: 1990 }) })));
        await collect(service.searchGames(searchRequest({ filter: byYear({ min: 1990, includeUnknown: true }) })));

        const [strictKey, looseKey] = cache.get.mock.calls.map(([key]) => key);
        expect(strictKey).toBeDefined();
        expect(looseKey).not.toBe(strictKey);
        expect(registry.resolved).toEqual(['bgg', 'bgg']);
      });

      it('asks a DataGateway that narrows by publish year again for each range it hasn’t been asked', async () => {
        registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [nineties] }), EVERY_CAPABILITY, {
          filterableAxes: [SearchFilterAxis.PublishYear],
        });

        for (const range of [{ min: 1990 }, { min: 2000 }, { max: 1990 }, { max: 2000 }, { min: 2000 }]) {
          await collect(service.searchGames(searchRequest({ filter: byYear(range) })));
        }

        expect(registry.resolved).toEqual(['bgg', 'bgg', 'bgg', 'bgg']);
      });

      it('sends a DataGateway that doesn’t narrow by publish year no year, and still filters its results', async () => {
        const bgg = new InMemoryGatewayDriver({ searchResults: [old, recent] });
        registry.register('bgg', bgg, EVERY_CAPABILITY, { filterableAxes: [SearchFilterAxis.ContentType] });
        const searched = sentTo(bgg);

        const frames = await collect(service.searchGames(searchRequest({ filter: byYear({ min: 2000 }) })));

        expect(searched.mock.calls[0]?.[0]).not.toHaveProperty('filter');
        expect(games(frames)).toEqual([recent]);
      });
    });

    // Declaring player count or play time promises that a DataGateway's
    // results carry the value and that its search narrows by it. Without it, a
    // search that keeps no unknown values can't count on any result passing,
    // so the DataGateway isn't asked, and answers UNFILTERABLE (#869).
    describe('by player count and play time', () => {
      const forPlayers = (externalId: string, minPlayers?: number, maxPlayers?: number): proto.GameSearchData => ({
        ...searchHit(externalId, externalId),
        minPlayers,
        maxPlayers,
      });

      const byPlayers = (playerCount: proto.IntRange, contentTypes: proto.ContentType[] = []): proto.SearchFilter => ({
        platformTypes: [],
        contentTypes,
        playerCount,
      });

      const byPlayTime = (playTime: proto.IntRange): proto.SearchFilter => ({
        platformTypes: [],
        contentTypes: [],
        playTime,
      });

      const [twoToSix, twoToThree, uncounted] = [
        forPlayers('two-to-six', 2, 6),
        forPlayers('two-to-three', 2, 3),
        forPlayers('uncounted'),
      ];

      it('answers UNFILTERABLE for a DataGateway that does not declare player count, without asking it (#869)', async () => {
        const bgg = new InMemoryGatewayDriver({ searchResults: [twoToSix] });
        registry.register('bgg', bgg, EVERY_CAPABILITY, { filterableAxes: [SearchFilterAxis.ContentType] });
        const searched = sentTo(bgg);

        const frames = await collect(service.searchGames(searchRequest({ filter: byPlayers({ min: 4 }) })));

        expect(frames).toEqual([{ correlationId: 'corr-1', gatewayId: 'bgg', status: UNFILTERABLE }]);
        expect(searched).not.toHaveBeenCalled();
        expect(cache.get).not.toHaveBeenCalled();
        expect(cache.set).not.toHaveBeenCalled();
      });

      it('asks it when the player-count range keeps unknown values', async () => {
        const bgg = new InMemoryGatewayDriver({ searchResults: [twoToSix, twoToThree, uncounted] });
        registry.register('bgg', bgg, EVERY_CAPABILITY, { filterableAxes: [SearchFilterAxis.ContentType] });
        const searched = sentTo(bgg);

        const frames = await collect(
          service.searchGames(searchRequest({ filter: byPlayers({ min: 4, includeUnknown: true }, [BASE_GAME]) })),
        );

        expect(searched).toHaveBeenCalledWith(
          expect.objectContaining({ filter: { platformTypes: [], contentTypes: [BASE_GAME] } }),
        );
        expect(games(frames)).toEqual([twoToSix, uncounted]);
      });

      // A named DataGateway this process hasn't connected is searched live, and
      // its search filters are read as it's resolved (#722).
      it('answers UNFILTERABLE on the live path too', async () => {
        const bgg = new InMemoryGatewayDriver({ searchResults: [twoToSix] });
        const searched = sentTo(bgg);
        jest.spyOn(registry, 'searchRoute').mockResolvedValue({ routable: false });
        jest
          .spyOn(registry, 'resolveSearch')
          .mockResolvedValue({ driver: bgg, filterableAxes: [], contentFormat: ContentFormat.PlainText });

        const frames = await collect(
          service.searchGames(searchRequest({ gatewayIds: ['bgg'], filter: byPlayers({ min: 4 }) })),
        );

        expect(frames).toEqual([{ correlationId: 'corr-1', gatewayId: 'bgg', status: UNFILTERABLE }]);
        expect(searched).not.toHaveBeenCalled();
        expect(cache.get).not.toHaveBeenCalled();
        expect(cache.set).not.toHaveBeenCalled();
      });

      it('answers SOURCE_DONE, not UNFILTERABLE, when coverage misses as well', async () => {
        const igdb = new InMemoryGatewayDriver({ searchResults: [catanOnPc] });
        registry.register('igdb', igdb, EVERY_CAPABILITY, { coverage: VIDEO_GAMES });
        const searched = sentTo(igdb);

        const frames = await collect(
          service.searchGames(
            searchRequest({ gatewayIds: ['igdb'], filter: { ...byPlayers({ min: 4 }), platformTypes: [TABLETOP] } }),
          ),
        );

        expect(frames).toEqual([{ correlationId: 'corr-1', gatewayId: 'igdb', status: SOURCE_DONE }]);
        expect(searched).not.toHaveBeenCalled();
      });

      // A bound alone is one count, so these are one search. They're sent as
      // the same range, so they share one entry and one upstream call (#869).
      it('keys a player count given by either bound alone or by both as one search', async () => {
        registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [twoToSix] }), EVERY_CAPABILITY, {
          filterableAxes: [SearchFilterAxis.PlayerCount],
        });

        for (const playerCount of [{ min: 5 }, { max: 5 }, { min: 5, max: 5 }]) {
          await collect(service.searchGames(searchRequest({ filter: byPlayers(playerCount) })));
        }

        const keys = cache.get.mock.calls.map(([key]) => key);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size).toBe(1);
        expect(registry.resolved).toEqual(['bgg']);
      });

      // One that narrows upstream answers each of these differently, so no two
      // may share an entry. The unfiltered search is among them: a range whose
      // one bound left no mark on the key would collide with it. A player count
      // is sent with both bounds, so its ranges differ in one bound at a time
      // (#869).
      it('keys the cache by each bound of both ranges, and whether each keeps unknown values', async () => {
        registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [twoToSix] }), EVERY_CAPABILITY, {
          filterableAxes: [SearchFilterAxis.PlayerCount, SearchFilterAxis.PlayTime],
        });
        const filters: proto.SearchFilter[] = [
          { platformTypes: [], contentTypes: [] },
          byPlayers({ min: 3 }),
          byPlayers({ min: 3, max: 5 }),
          byPlayers({ min: 2, max: 5 }),
          byPlayers({ min: 3, includeUnknown: true }),
          byPlayTime({ min: 3 }),
          byPlayTime({ max: 3 }),
          byPlayTime({ min: 3, includeUnknown: true }),
        ];

        for (const filter of filters) {
          await collect(service.searchGames(searchRequest({ filter })));
        }

        expect(new Set(cache.get.mock.calls.map(([key]) => key)).size).toBe(filters.length);
      });
    });
  });

  describe('searchGames cache', () => {
    beforeEach(() => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan, brass] }));
    });

    it('stops replaying a DataGateway’s cached results once it may no longer search, and says why', async () => {
      await collect(service.searchGames(searchRequest({ gatewayIds: ['bgg'] })));

      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan, brass] }), [
        DataGatewayCapability.Fetch,
      ]);
      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['bgg'] })));

      expect(frames).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          status: UNAVAILABLE,
          message: `DataGateway bgg doesn't declare Search`,
        },
      ]);
    });

    it('replays a completed search from the cache without asking the gateway again', async () => {
      await collect(service.searchGames(searchRequest()));
      registry.resolved.length = 0;

      const replay = await collect(service.searchGames(searchRequest()));

      expect(registry.resolved).toEqual([]);
      // Replay looks dedup up concurrently, so only SOURCE_DONE's place is fixed.
      expect(replay).toHaveLength(3);
      expect(replay.slice(0, 2)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: RESULT, game: catan }),
          expect.objectContaining({ status: RESULT, game: brass }),
        ]),
      );
      expect(replay.at(-1)).toEqual({ correlationId: 'corr-1', gatewayId: 'bgg', status: SOURCE_DONE });
    });

    it('resolves dedup afresh on a replay, so a game imported since the first search shows as in the system', async () => {
      await collect(service.searchGames(searchRequest()));
      imported.set('bgg:13', 'game-catan');
      registry.resolved.length = 0;

      const replay = await collect(service.searchGames(searchRequest()));

      expect(registry.resolved).toEqual([]);
      expect(replay).toContainEqual(expect.objectContaining({ game: catan, inSystem: true, gameId: 'game-catan' }));
    });

    it('caches what the DataGateway answered and filters it again on replay, so searches it would answer alike share the entry', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [tabletopCatan, seafarers] }));

      const live = await collect(
        service.searchGames(searchRequest({ filter: { platformTypes: [], contentTypes: [BASE_GAME] } })),
      );
      registry.resolved.length = 0;
      const replay = await collect(
        service.searchGames(searchRequest({ filter: { platformTypes: [], contentTypes: [EXPANSION] } })),
      );

      expect(registry.resolved).toEqual([]);
      expect(live.filter((frame) => frame.status === RESULT)).toEqual([
        expect.objectContaining({ game: tabletopCatan }),
      ]);
      expect(replay).toEqual([
        expect.objectContaining({ status: RESULT, game: seafarers }),
        { correlationId: 'corr-1', gatewayId: 'bgg', status: SOURCE_DONE },
      ]);
    });

    it('asks a DataGateway again for a filter it narrows by that differs from the one it was asked', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [tabletopCatan, seafarers] }), undefined, {
        filterableAxes: [SearchFilterAxis.ContentType],
      });

      await collect(service.searchGames(searchRequest({ filter: { platformTypes: [], contentTypes: [BASE_GAME] } })));
      await collect(service.searchGames(searchRequest({ filter: { platformTypes: [], contentTypes: [EXPANSION] } })));
      await collect(
        service.searchGames(searchRequest({ filter: { platformTypes: [TABLETOP], contentTypes: [EXPANSION] } })),
      );

      expect(registry.resolved).toEqual(['bgg', 'bgg']);
    });

    it('does not serve one query from another query’s cached results', async () => {
      await collect(service.searchGames(searchRequest({ query: 'catan' })));
      registry.resolved.length = 0;

      await collect(service.searchGames(searchRequest({ query: 'brass' })));

      expect(registry.resolved).toEqual(['bgg']);
    });

    it('does not cache a search the gateway reported a problem in, so the next one asks it again', async () => {
      registry.register(
        'bgg',
        scriptedDriver({
          searchGames: [
            { correlationId: 'corr-1', status: RESULT, game: catan },
            { correlationId: 'corr-1', status: RATE_LIMITED, message: 'slow down', retryAfter: 30 },
            { correlationId: 'corr-1', status: SOURCE_DONE },
          ],
        }),
      );

      await collect(service.searchGames(searchRequest()));
      registry.resolved.length = 0;
      await collect(service.searchGames(searchRequest()));

      expect(registry.resolved).toEqual(['bgg']);
    });

    it('ends a replay with an ERROR frame when a dedup lookup fails', async () => {
      await collect(service.searchGames(searchRequest()));
      registry.resolved.length = 0;
      db.gameSource.findUnique.mockRejectedValue(new Error('connection pool exhausted'));

      const replay = await collect(service.searchGames(searchRequest()));

      expect(registry.resolved).toEqual([]);
      expect(replay).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          status: ERROR,
          message: 'connection pool exhausted',
        },
      ]);
    });

    it('asks a DataGateway its cache misses through the route it read, without resolving it again', async () => {
      const resolveSearch = jest.spyOn(registry, 'resolveSearch');

      const frames = await collect(service.searchGames(searchRequest()));

      expect(resolveSearch).not.toHaveBeenCalled();
      expect(registry.resolved).toEqual(['bgg']);
      expect(frames.filter((frame) => frame.status === RESULT)).toHaveLength(2);
    });

    it('answers UNAVAILABLE when a DataGateway its cache misses can’t be connected', async () => {
      jest.spyOn(registry, 'searchRoute').mockResolvedValue({
        routable: true,
        covers: true,
        filterableAxes: [],
        contentFormat: null,
        driver: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:50051')),
      });

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['bgg'] })));

      expect(frames).toEqual([
        { correlationId: 'corr-1', gatewayId: 'bgg', status: UNAVAILABLE, message: 'DataGateway bgg is not connected' },
      ]);
    });

    it('falls through to the gateway when the cache cannot be read', async () => {
      cache.get.mockRejectedValueOnce(new Error('cache down'));

      const frames = await collect(service.searchGames(searchRequest()));

      expect(registry.resolved).toEqual(['bgg']);
      expect(frames.filter((frame) => frame.status === RESULT)).toHaveLength(2);
    });

    it('still completes the search, and logs the failure, when the cache cannot be written', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      cache.set.mockRejectedValueOnce(new Error('cache down'));

      try {
        const frames = await collect(service.searchGames(searchRequest()));

        expect(frames.at(-1)).toEqual({ correlationId: 'corr-1', gatewayId: 'bgg', status: SOURCE_DONE });
        expect(warn).toHaveBeenCalledWith('Search cache write failed for gateway bgg: cache down');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('summaries', () => {
    const summarized = (summary: string): proto.GameSearchData => ({ ...catan, summary });
    const summaries = (frames: proto.SearchGameResult[]) =>
      frames.filter((frame) => frame.status === RESULT).map((frame) => frame.game?.summary);

    it("sends each result's summary as Markdown, converted from its DataGateway's content format", async () => {
      registry
        .register('bgg', new InMemoryGatewayDriver({ searchResults: [summarized('[b]Trade[/b] wisely')] }), undefined, {
          contentFormat: ContentFormat.BBCode,
        })
        .register(
          'html',
          new InMemoryGatewayDriver({ searchResults: [summarized('<p>Trade <i>wisely</i></p>')] }),
          undefined,
          {
            contentFormat: ContentFormat.Html,
          },
        );

      const frames = await collect(service.searchGames(searchRequest()));

      expect(summaries(frames.filter((frame) => frame.gatewayId === 'bgg'))).toEqual(['**Trade** wisely']);
      expect(summaries(frames.filter((frame) => frame.gatewayId === 'html'))).toEqual(['Trade *wisely*']);
    });

    it('converts the summary of a DataGateway that declared no content format as plain text', async () => {
      registry.register(
        'bgg',
        new InMemoryGatewayDriver({ searchResults: [summarized('#1 <b>pick</b>')] }),
        undefined,
        {
          contentFormat: null,
        },
      );

      const frames = await collect(service.searchGames(searchRequest()));

      expect(summaries(frames)).toEqual([String.raw`\#1 \<b>pick\</b>`]);
    });

    it('caches summaries as the DataGateway sent them, and converts them by the content format it declares when replayed', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [summarized('<b>Trade</b>')] }));
      const live = await collect(service.searchGames(searchRequest()));

      registry.register('bgg', new InMemoryGatewayDriver(), undefined, { contentFormat: ContentFormat.Html });
      const replay = await collect(service.searchGames(searchRequest()));

      expect(cache.set).toHaveBeenCalledWith(expect.any(String), [summarized('<b>Trade</b>')], expect.any(Number));
      expect(summaries(live)).toEqual([String.raw`\<b>Trade\</b>`]);
      expect(summaries(replay)).toEqual(['**Trade**']);
    });

    it("sends an expansion's summary as Markdown too", async () => {
      db.gameSource.findMany.mockResolvedValue([{ gatewayId: 'bgg', externalId: '13' }] as never);
      registry.register(
        'bgg',
        new InMemoryGatewayDriver({ expansionsByBaseExternalId: { '13': [summarized('<i>More</i> players')] } }),
        undefined,
        { contentFormat: ContentFormat.Html },
      );

      const frames = await collect(service.fetchExpansions({ correlationId: 'corr-3', gameId: 'game-1' }));

      expect(summaries(frames)).toEqual(['*More* players']);
    });

    it('sends a result with no summary without one', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan] }), undefined, {
        contentFormat: ContentFormat.Html,
      });

      const frames = await collect(service.searchGames(searchRequest()));

      expect(summaries(frames)).toEqual([undefined]);
    });
  });

  describe('fetchGame', () => {
    const catanData = { externalId: '13', title: 'Catan' } as unknown as proto.GameData;

    const fetchRequest = (gatewayId: string, externalId: string): proto.CoordinatorFetchGameRequest => ({
      correlationId: 'corr-2',
      gatewayId,
      externalId,
    });

    it('returns the gateway’s game, attributed to that gateway', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ games: [catanData] }));

      const response = await lastValueFrom(service.fetchGame(fetchRequest('bgg', '13')));

      expect(response).toEqual({ correlationId: 'corr-2', gatewayId: 'bgg', status: RESULT, game: catanData });
    });

    it('passes a gateway’s clean not-found through as its answer', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ games: [catanData] }));

      const response = await lastValueFrom(service.fetchGame(fetchRequest('bgg', '999')));

      expect(response).toEqual({
        correlationId: 'corr-2',
        gatewayId: 'bgg',
        status: ERROR,
        message: 'No game found for externalId 999',
      });
    });

    it('answers an unreachable gateway with an ERROR response instead of failing the stream', async () => {
      const response = await lastValueFrom(service.fetchGame(fetchRequest('steam', '13')));

      expect(response).toEqual({
        correlationId: 'corr-2',
        gatewayId: 'steam',
        status: ERROR,
        message: 'No connection established for gateway steam.',
      });
    });

    it('answers a DataGateway that may not fetch with an ERROR response saying why', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ games: [catanData] }), [DataGatewayCapability.Search]);

      const response = await lastValueFrom(service.fetchGame(fetchRequest('bgg', '13')));

      expect(response).toEqual({
        correlationId: 'corr-2',
        gatewayId: 'bgg',
        status: ERROR,
        message: `DataGateway bgg doesn't declare Fetch`,
      });
    });

    it('answers a failing gateway with an ERROR response carrying the failure', async () => {
      const failing = new InMemoryGatewayDriver({ games: [catanData] });
      failing.failWith(new Error('upstream exploded'));
      registry.register('bgg', failing);

      const response = await lastValueFrom(service.fetchGame(fetchRequest('bgg', '13')));

      expect(response).toEqual(expect.objectContaining({ status: ERROR, message: 'upstream exploded' }));
    });

    it('resolves the gateway on every subscription, so a retry reaches a reconnected driver', async () => {
      const fetch$ = service.fetchGame(fetchRequest('bgg', '13'));
      await lastValueFrom(fetch$);

      registry.register('bgg', new InMemoryGatewayDriver({ games: [catanData] }));
      const retried = await lastValueFrom(fetch$);

      expect(registry.resolved).toEqual(['bgg', 'bgg']);
      expect(retried).toEqual(expect.objectContaining({ status: RESULT, game: catanData }));
    });
  });

  describe('fetchExpansions', () => {
    const seafarers = searchHit('325', 'Catan: Seafarers');
    const haloDlc = searchHit('7401', 'Halo: Firefight');

    const expansionsRequest: proto.CoordinatorFetchExpansionsRequest = { correlationId: 'corr-3', gameId: 'game-1' };

    /** The gatewayId on a frame that no single gateway answers for. */
    const NO_GATEWAY = '__no_gateway__';

    it('asks each gateway the game is linked to for expansions of its own external id', async () => {
      db.gameSource.findMany.mockResolvedValue([
        { gatewayId: 'bgg', externalId: '13' },
        { gatewayId: 'igdb', externalId: '740' },
      ] as never);
      registry
        .register('bgg', new InMemoryGatewayDriver({ expansionsByBaseExternalId: { '13': [seafarers] } }))
        .register('igdb', new InMemoryGatewayDriver({ expansionsByBaseExternalId: { '740': [haloDlc] } }));
      imported.set('bgg:325', 'game-seafarers');

      const frames = await collect(service.fetchExpansions(expansionsRequest));

      expect(db.gameSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { gameId: 'game-1' } }));
      expect(frames).toHaveLength(2);
      expect(frames).toEqual(
        expect.arrayContaining([
          {
            correlationId: 'corr-3',
            gatewayId: 'bgg',
            status: RESULT,
            game: seafarers,
            inSystem: true,
            gameId: 'game-seafarers',
          },
          {
            correlationId: 'corr-3',
            gatewayId: 'igdb',
            status: RESULT,
            game: haloDlc,
            inSystem: false,
            gameId: undefined,
          },
        ]),
      );
    });

    it('reports a linked gateway it cannot reach as UNAVAILABLE rather than as having no expansions', async () => {
      db.gameSource.findMany.mockResolvedValue([{ gatewayId: 'bgg', externalId: '13' }] as never);

      const frames = await collect(service.fetchExpansions(expansionsRequest));

      expect(frames).toEqual([
        {
          correlationId: 'corr-3',
          gatewayId: 'bgg',
          status: UNAVAILABLE,
          message: 'DataGateway bgg is not connected',
        },
      ]);
    });

    it('reports a linked DataGateway that may not fetch expansions as UNAVAILABLE, saying why', async () => {
      db.gameSource.findMany.mockResolvedValue([{ gatewayId: 'bgg', externalId: '13' }] as never);
      registry.register('bgg', new InMemoryGatewayDriver({ expansionsByBaseExternalId: { '13': [seafarers] } }), [
        DataGatewayCapability.Search,
        DataGatewayCapability.Fetch,
      ]);

      const frames = await collect(service.fetchExpansions(expansionsRequest));

      expect(frames).toEqual([
        {
          correlationId: 'corr-3',
          gatewayId: 'bgg',
          status: UNAVAILABLE,
          message: `DataGateway bgg doesn't declare FetchExpansions`,
        },
      ]);
    });

    it('relays a gateway’s non-result frames with their message and retry hint', async () => {
      db.gameSource.findMany.mockResolvedValue([{ gatewayId: 'bgg', externalId: '13' }] as never);
      registry.register(
        'bgg',
        scriptedDriver({
          fetchExpansions: [{ correlationId: 'corr-3', status: RATE_LIMITED, message: 'slow down', retryAfter: 30 }],
        }),
      );

      const frames = await collect(service.fetchExpansions(expansionsRequest));

      expect(frames).toEqual([
        {
          correlationId: 'corr-3',
          gatewayId: 'bgg',
          status: RATE_LIMITED,
          message: 'slow down',
          retryAfter: 30,
        },
      ]);
    });

    it('answers a game linked to no gateway with one ERROR frame that names the game but no gateway', async () => {
      db.gameSource.findMany.mockResolvedValue([] as never);

      const frames = await collect(service.fetchExpansions(expansionsRequest));

      expect(frames).toEqual([
        {
          correlationId: 'corr-3',
          gatewayId: NO_GATEWAY,
          status: ERROR,
          message: 'No gateway sources found for gameId game-1',
        },
      ]);
    });

    it('answers a failed source lookup with one ERROR frame that names no gateway', async () => {
      db.gameSource.findMany.mockRejectedValue(new Error('connection pool exhausted'));

      const frames = await collect(service.fetchExpansions(expansionsRequest));

      expect(frames).toEqual([
        {
          correlationId: 'corr-3',
          gatewayId: NO_GATEWAY,
          status: ERROR,
          message: 'connection pool exhausted',
        },
      ]);
    });
  });
});
