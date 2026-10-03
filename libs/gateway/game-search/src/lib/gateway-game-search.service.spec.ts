import { GatewayRegistryService } from '@bge/gateway-registry';
import { createTestingModuleWithDb, type CacheMock, type MockDatabaseService } from '@bge/testing';
import type { GameGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
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

interface ScriptedStreams {
  searchGames?: proto.GatewaySearchResult[];
  fetchExpansions?: proto.GatewaySearchResult[];
}

/** A driver whose streams are exactly the given frames, for statuses the fixture-backed driver never produces. */
const scriptedDriver = ({ searchGames = [], fetchExpansions = [] }: ScriptedStreams): GameGatewayDriver =>
  Object.assign(new InMemoryGatewayDriver(), {
    searchGames: () => from(searchGames),
    fetchExpansions: () => from(fetchExpansions),
  });

/**
 * Stands in for GatewayRegistryService with the two calls the service makes,
 * typed against the real ones so the two cannot drift apart. Like the real
 * registry, `resolve` rejects for a gateway it cannot produce a driver for,
 * and only registered gateways count as connected.
 */
class FakeRegistry implements Pick<GatewayRegistryService, 'resolve' | 'connectedGatewayIds'> {
  readonly resolved: string[] = [];
  private readonly drivers = new Map<string, GameGatewayDriver>();

  register(gatewayId: string, driver: GameGatewayDriver): this {
    this.drivers.set(gatewayId, driver);
    return this;
  }

  connectedGatewayIds(): string[] {
    return [...this.drivers.keys()];
  }

  async resolve(gatewayId: string): Promise<GameGatewayDriver> {
    this.resolved.push(gatewayId);

    const driver = this.drivers.get(gatewayId);
    if (!driver) {
      throw new Error(`No connection established for gateway ${gatewayId}.`);
    }

    return driver;
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
    it('fans an untargeted search out to every connected gateway, each closing with its own SOURCE_DONE', async () => {
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

    it('reports a gateway it cannot reach as UNAVAILABLE while the others still answer', async () => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan] }));

      const frames = await collect(service.searchGames(searchRequest({ gatewayIds: ['bgg', 'steam'] })));

      expect(frames.filter((frame) => frame.gatewayId === 'steam')).toEqual([
        {
          correlationId: 'corr-1',
          gatewayId: 'steam',
          status: UNAVAILABLE,
          message: 'Gateway steam is not connected',
        },
      ]);
      expect(frames).toContainEqual(expect.objectContaining({ gatewayId: 'bgg', status: SOURCE_DONE }));
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

  describe('searchGames cache', () => {
    beforeEach(() => {
      registry.register('bgg', new InMemoryGatewayDriver({ searchResults: [catan, brass] }));
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
          message: 'Gateway bgg is not connected',
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
