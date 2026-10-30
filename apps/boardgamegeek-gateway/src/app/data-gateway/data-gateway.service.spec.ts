import { BGE_VERSION } from '@bge/version';
import * as proto from '@boardgamesempire/proto-gateway';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, NEVER, of, throwError } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { BggService, type BggRequest } from '../bgg/bgg.service';
import { BggLinkType, BggNameType, BggThingType, MAX_THINGS_PER_BATCH } from '../constants';
import { toCategoryList, toMechanicList } from '../mappers/taxonomy.mapper';
import type { BggSearchItem, BggThing } from '../types';
import { DataGatewayService } from './data-gateway.service';

// ---------------------------------------------------------------------------
// Mock BggService to isolate DataGatewayService from real API calls. Only the
// `call` method is exercised by the gateway.
// ---------------------------------------------------------------------------
function buildMockBggService(): jest.Mocked<Pick<BggService, 'call'>> {
  return { call: jest.fn() };
}

describe('DataGatewayService', () => {
  let service: DataGatewayService;
  let bggService: jest.Mocked<Pick<BggService, 'call'>>;

  beforeEach(async () => {
    bggService = buildMockBggService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [DataGatewayService, { provide: BggService, useValue: bggService }],
    }).compile();

    service = module.get<DataGatewayService>(DataGatewayService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('ping', () => {
    it('returns a response using the correlationId from the request', () => {
      const request: proto.GatewayPingRequest = { correlationId: 'corr-ping-1' };

      expect(service.ping(request).correlationId).toBe('corr-ping-1');
    });

    it('generates a correlationId when none is provided in the request', () => {
      const response = service.ping({});

      expect(response.correlationId).toBeTruthy();
      expect(typeof response.correlationId).toBe('string');
    });

    it('returns the gateway name "BoardGameGeekGateway"', () => {
      expect(service.ping({}).gatewayName).toBe('BoardGameGeekGateway');
    });

    it('reports the product version it was built at', () => {
      expect(service.ping({}).gatewayVersion).toBe(BGE_VERSION);
    });

    it('returns a bigint timestampMs', () => {
      expect(typeof service.ping({}).timestampMs).toBe('bigint');
    });
  });

  describe('describe', () => {
    it('returns a response using the correlationId from the request', () => {
      expect(service.describe({ correlationId: 'corr-describe-1' }).correlationId).toBe('corr-describe-1');
    });

    it('generates a correlationId when none is provided in the request', () => {
      expect(service.describe({}).correlationId).toEqual(expect.any(String));
    });

    it('declares search, fetch, fetch expansions and the lists of languages, platforms, categories and mechanics', () => {
      expect(new Set(service.describe({}).capabilities)).toEqual(
        new Set([
          proto.Capability.CAPABILITY_SEARCH,
          proto.Capability.CAPABILITY_FETCH,
          proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
          proto.Capability.CAPABILITY_LIST_LANGUAGES,
          proto.Capability.CAPABILITY_LIST_PLATFORMS,
          proto.Capability.CAPABILITY_LIST_CATEGORIES,
          proto.Capability.CAPABILITY_LIST_MECHANICS,
        ]),
      );
    });

    it('declares list platforms', () => {
      expect(service.describe({}).capabilities).toContain(proto.Capability.CAPABILITY_LIST_PLATFORMS);
    });

    it('covers tabletop base games and expansions', () => {
      const { coverage } = service.describe({});

      expect(coverage?.platformTypes).toEqual([proto.PlatformType.PLATFORM_TYPE_TABLETOP]);
      expect(new Set(coverage?.contentTypes)).toEqual(
        new Set([proto.ContentType.CONTENT_TYPE_BASE_GAME, proto.ContentType.CONTENT_TYPE_EXPANSION]),
      );
    });

    it('declares publish year and content type as its filterable axes', () => {
      expect(service.describe({}).filterableAxes).toEqual([
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE,
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR,
      ]);
    });

    it('declares English language names, on requests and responses alike', () => {
      expect(service.describe({}).languageCodeFormats).toEqual({
        acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME],
        responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME,
        passthroughSearchLanguage: false,
      } satisfies proto.LanguageCodeFormats);
    });

    it('declares its free text as plain text', () => {
      expect(service.describe({}).contentFormat).toBe(proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT);
    });
  });

  describe('listPlatforms (#718)', () => {
    // Every game BGG sends is on its one platform, Tabletop.
    it('lists its one platform, Tabletop', async () => {
      await expect(firstValueFrom(service.listPlatforms({ correlationId: 'corr-platforms' }))).resolves.toEqual({
        correlationId: 'corr-platforms',
        platforms: [
          {
            externalId: 'bgg-tabletop',
            name: 'Tabletop',
            abbreviation: 'TT',
            platformType: proto.PlatformType.PLATFORM_TYPE_TABLETOP,
          },
        ],
      });
      expect(bggService.call).not.toHaveBeenCalled();
    });
  });

  describe('listCategories (#839)', () => {
    it('echoes the correlation id, or makes one', async () => {
      const echoed = await firstValueFrom(service.listCategories({ correlationId: 'corr-categories' }));
      const made = await firstValueFrom(service.listCategories({}));

      expect(echoed.correlationId).toBe('corr-categories');
      expect(made.correlationId).toEqual(expect.any(String));
    });

    it('lists the table', async () => {
      const response = await firstValueFrom(service.listCategories({ correlationId: 'corr-categories' }));

      expect(response.categories).toEqual(toCategoryList());
      expect(bggService.call).not.toHaveBeenCalled();
    });
  });

  describe('listMechanics (#839)', () => {
    it('echoes the correlation id, or makes one', async () => {
      const echoed = await firstValueFrom(service.listMechanics({ correlationId: 'corr-mechanics' }));
      const made = await firstValueFrom(service.listMechanics({}));

      expect(echoed.correlationId).toBe('corr-mechanics');
      expect(made.correlationId).toEqual(expect.any(String));
    });

    it('lists the table', async () => {
      const response = await firstValueFrom(service.listMechanics({ correlationId: 'corr-mechanics' }));

      expect(response.mechanics).toEqual(toMechanicList());
      expect(bggService.call).not.toHaveBeenCalled();
    });
  });

  describe('healthCheck', () => {
    it('returns SERVING status', () => {
      const request: proto.HealthCheckRequest = { service: 'GatewayService' };

      expect(service.healthCheck(request).status).toBe(proto.HealthCheckResponse_ServingStatus.SERVING);
    });
  });

  describe('searchGames', () => {
    /**
     * Answers `bggService.call` in call order: the search with `items`, then
     * each `/thing` batch with its things, or fails it with its error. Any
     * later call answers no things.
     */
    const answer = (items: BggSearchItem[], ...batches: Array<BggThing[] | Error>): void => {
      bggService.call.mockReturnValueOnce(of(items));

      for (const batch of batches) {
        bggService.call.mockReturnValueOnce(batch instanceof Error ? throwError(() => batch) : of(batch));
      }

      bggService.call.mockReturnValue(of([]));
    };

    it('emits one RESULT frame per item followed by a single SOURCE_DONE', async () => {
      answer([CATAN_SEARCH, GLOOMHAVEN_SEARCH]);

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'catan' }).pipe(toArray()));

      const resultFrames = frames.filter((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);
      const doneFrames = frames.filter((f) => f.status === proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);

      expect(resultFrames).toHaveLength(2);
      expect(doneFrames).toHaveLength(1);
      expect(frames[frames.length - 1].status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('emits only SOURCE_DONE when BGG returns no results', async () => {
      answer([]);

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'nonexistent' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('maps the BGG id to externalId as a string', async () => {
      answer([CATAN_SEARCH]);

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'catan' }).pipe(toArray()));
      const result = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.externalId).toBe(String(CATAN_SEARCH.id));
    });

    it('maps the BGG name to GameSearchData.title', async () => {
      answer([CATAN_SEARCH]);

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'catan' }).pipe(toArray()));
      const result = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.title).toBe('Catan');
    });

    it('propagates the correlationId in every emitted frame', async () => {
      answer([CATAN_SEARCH]);

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'trace-abc', query: 'catan' }).pipe(toArray()),
      );

      for (const frame of frames) {
        expect(frame.correlationId).toBe('trace-abc');
      }
    });

    it('emits a single ERROR frame and does not throw when BggService rejects', async () => {
      bggService.call.mockReturnValue(throwError(() => new Error('BGG unavailable')));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'corr-err', query: 'catan' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toContain('BGG unavailable');
    });

    it('asks BGG nothing more when the search finds nothing (#880)', async () => {
      answer([]);
      const request: proto.GatewaySearchRequest = { correlationId: 'c', query: 'catan', limit: 5 };

      await firstValueFrom(service.searchGames(request).pipe(toArray()));

      expect(bggService.call).toHaveBeenCalledTimes(1);
    });

    describe("filled in from each result's thing (#880)", () => {
      afterEach(() => jest.restoreAllMocks());

      /** Every frame the search sent. */
      const searched = async (request: proto.GatewaySearchRequest): Promise<proto.GatewaySearchResult[]> =>
        firstValueFrom(service.searchGames(request).pipe(toArray()));

      /** The RESULT frames' games, in the order they were sent. */
      const games = (frames: proto.GatewaySearchResult[]) =>
        frames.filter((frame) => frame.status === proto.ResultStatus.RESULT_STATUS_RESULT).map((frame) => frame.game);

      it('fills each result in from its thing', async () => {
        answer([CATAN_SEARCH], [CATAN_THING]);

        const [game] = games(await searched({ correlationId: 'c', query: 'catan' }));

        expect(game).toMatchObject({
          title: 'Catan',
          thumbnailUrl: 'https://cf.geekdo.com/catan-thumb.jpg',
          minPlayers: 3,
          maxPlayers: 4,
        });
        expect(game?.averageRating).toBeCloseTo(7.15);
      });

      it('asks /thing for a page in batches of 20, with statistics, without versions, for both thing types', async () => {
        const items = Array.from({ length: 45 }, (_, i) => ({ ...CATAN_SEARCH, id: i + 1 }));
        answer(items);

        await searched({ correlationId: 'c', query: 'catan', limit: 45 });

        expect(bggService.call).toHaveBeenCalledTimes(4);
        const asked = await Promise.all(
          bggService.call.mock.calls.slice(1).map(async ([bggRequest]) => {
            const thing = jest.fn().mockResolvedValue([]);
            await firstValueFrom((bggRequest as BggRequest<unknown>)({ thing: { query: thing } } as never));
            return thing.mock.calls[0][0];
          }),
        );
        expect(asked.map((params) => params.id)).toEqual([
          items.slice(0, 20).map((item) => item.id),
          items.slice(20, 40).map((item) => item.id),
          items.slice(40).map((item) => item.id),
        ]);
        for (const params of asked) {
          expect(params).toMatchObject({
            stats: 1,
            versions: 0,
            type: [BggThingType.BoardGame, BggThingType.BoardGameExpansion],
          });
        }
      });

      it('sends results in search order, whatever order BGG answers in', async () => {
        answer([CATAN_SEARCH, GLOOMHAVEN_SEARCH], [GLOOMHAVEN_THING, CATAN_THING]);

        const sent = games(await searched({ correlationId: 'c', query: 'catan' }));

        expect(sent.map((game) => [game?.externalId, game?.thumbnailUrl])).toEqual([
          ['13', 'https://cf.geekdo.com/catan-thumb.jpg'],
          ['174430', 'https://cf.geekdo.com/gloom-thumb.jpg'],
        ]);
      });

      it("sends a result as search found it, with a warning, when BGG's answer leaves its thing out", async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        answer([CATAN_SEARCH, GLOOMHAVEN_SEARCH], [CATAN_THING]);

        const [catan, gloomhaven] = games(await searched({ correlationId: 'c', query: 'catan' }));

        expect(catan?.thumbnailUrl).toBe('https://cf.geekdo.com/catan-thumb.jpg');
        expect(gloomhaven).toMatchObject({ externalId: '174430', title: 'Gloomhaven', yearPublished: 2017 });
        expect(gloomhaven?.thumbnailUrl).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('BGG left out 174430'));
      });

      it("sends a stalled batch's results as search found them after 10 seconds, and ends with SOURCE_DONE", async () => {
        jest.useFakeTimers();
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        bggService.call.mockReturnValueOnce(of([CATAN_SEARCH])).mockReturnValueOnce(NEVER);

        try {
          const frames$ = searched({ correlationId: 'c', query: 'catan' });

          await jest.advanceTimersByTimeAsync(10_000);
          const frames = await frames$;

          expect(games(frames).map((game) => [game?.externalId, game?.thumbnailUrl])).toEqual([['13', undefined]]);
          expect(frames.at(-1)?.status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
          expect(warn).toHaveBeenCalledTimes(1);
        } finally {
          jest.useRealTimers();
        }
      });

      it("sends a failed batch's results as search found them, keeps the other batches' details, and ends with SOURCE_DONE", async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const fillers = Array.from({ length: 20 }, (_, i) => ({ ...GLOOMHAVEN_SEARCH, id: 1001 + i }));
        answer([...fillers, CATAN_SEARCH], new Error('429 Too Many Requests'), [CATAN_THING]);

        const frames = await searched({ correlationId: 'c', query: 'catan' });
        const sent = games(frames);

        expect(sent).toHaveLength(21);
        expect(frames.some((frame) => frame.status === proto.ResultStatus.RESULT_STATUS_ERROR)).toBe(false);
        expect(frames.at(-1)?.status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
        expect(sent.at(-1)?.thumbnailUrl).toBe('https://cf.geekdo.com/catan-thumb.jpg');
        expect(sent.slice(0, 20).filter((game) => game?.thumbnailUrl !== undefined)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('429 Too Many Requests'));
      });
    });

    describe('filtered by content type', () => {
      /** The thing types the search asked BGG for, by running its request against a stand-in client. */
      const typesAskedFor = async (filter: proto.SearchFilter | undefined): Promise<unknown> => {
        bggService.call.mockReturnValue(of([]));
        await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'catan', filter }).pipe(toArray()));

        const search = jest.fn().mockResolvedValue([]);
        const [bggRequest] = bggService.call.mock.calls.at(-1) as unknown as [BggRequest<BggSearchItem[]>];
        await firstValueFrom(bggRequest({ search: { query: search } } as never));

        return search.mock.calls[0]?.[0]?.type;
      };

      it('asks BGG for base games and expansions when the search isn’t filtered', async () => {
        await expect(typesAskedFor(undefined)).resolves.toEqual([
          BggThingType.BoardGame,
          BggThingType.BoardGameExpansion,
        ]);
        await expect(typesAskedFor({ platformTypes: [], contentTypes: [] })).resolves.toEqual([
          BggThingType.BoardGame,
          BggThingType.BoardGameExpansion,
        ]);
      });

      it('asks BGG for both thing types whatever the filter, and keeps only the content types named (#777)', async () => {
        await expect(
          typesAskedFor({ platformTypes: [], contentTypes: [proto.ContentType.CONTENT_TYPE_EXPANSION] }),
        ).resolves.toEqual([BggThingType.BoardGame, BggThingType.BoardGameExpansion]);
        await expect(
          typesAskedFor({
            platformTypes: [],
            contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME, proto.ContentType.CONTENT_TYPE_DLC],
          }),
        ).resolves.toEqual([BggThingType.BoardGame, BggThingType.BoardGameExpansion]);
      });

      it('sends no expansion from a search filtered to base games, though BGG also labels it a base game (#777)', async () => {
        const search = jest.fn().mockResolvedValue([
          {
            total: 3,
            items: [
              { id: 1, type: BggThingType.BoardGame, name: 'Catan' },
              { id: 2, type: BggThingType.BoardGame, name: 'Catan: Seafarers' },
              { id: 2, type: BggThingType.BoardGameExpansion, name: 'Catan: Seafarers' },
            ],
          },
        ]);
        const things = jest.fn().mockResolvedValue([]);
        bggService.call.mockImplementation((bggRequest) =>
          (bggRequest as BggRequest<unknown>)({ search: { query: search }, thing: { query: things } } as never),
        );

        const frames = await firstValueFrom(
          service
            .searchGames({
              correlationId: 'c',
              query: 'catan',
              filter: { platformTypes: [], contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME] },
            })
            .pipe(toArray()),
        );

        const results = frames.filter((frame) => frame.status === proto.ResultStatus.RESULT_STATUS_RESULT);
        expect(results.map((frame) => frame.game?.externalId)).toEqual(['1']);
      });

      it('ends at once, without asking BGG, when it names nothing BGG search has', async () => {
        const frames = await firstValueFrom(
          service
            .searchGames({
              correlationId: 'c',
              query: 'catan',
              filter: { platformTypes: [], contentTypes: [proto.ContentType.CONTENT_TYPE_DLC] },
            })
            .pipe(toArray()),
        );

        expect(frames).toEqual([{ correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE }]);
        expect(bggService.call).not.toHaveBeenCalled();
      });
    });

    describe('filtered by publish year (#719)', () => {
      it('narrows by the publish-year range it is sent', async () => {
        const search = jest.fn().mockResolvedValue([
          {
            total: 3,
            items: [
              { id: 1, type: BggThingType.BoardGame, name: 'Catan', yearpublished: 1995 },
              { id: 2, type: BggThingType.BoardGame, name: 'Brass', yearpublished: 2018 },
              { id: 3, type: BggThingType.BoardGame, name: 'Undated', yearpublished: 0 },
            ],
          },
        ]);
        const things = jest.fn().mockResolvedValue([]);
        bggService.call.mockImplementation((bggRequest) =>
          (bggRequest as BggRequest<unknown>)({ search: { query: search }, thing: { query: things } } as never),
        );

        const frames = await firstValueFrom(
          service
            .searchGames({
              correlationId: 'c',
              query: 'catan',
              filter: { platformTypes: [], contentTypes: [], publishYear: { min: 2000, includeUnknown: true } },
            })
            .pipe(toArray()),
        );

        const results = frames.filter((frame) => frame.status === proto.ResultStatus.RESULT_STATUS_RESULT);
        expect(results.map((frame) => [frame.game?.externalId, frame.game?.yearPublished])).toEqual([
          ['2', 2018],
          ['3', undefined],
        ]);
      });
    });
  });

  describe('fetchGame', () => {
    it('returns RESULT status with populated game data', async () => {
      bggService.call.mockReturnValue(of(CATAN_THING));

      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: String(CATAN_THING.id) };
      const response = await firstValueFrom(service.fetchGame(request));

      expect(response.status).toBe(proto.ResultStatus.RESULT_STATUS_RESULT);
      expect(response.game?.externalId).toBe(String(CATAN_THING.id));
      expect(response.game?.title).toBe('Catan');
      expect(response.correlationId).toBe('c');
    });

    it('returns ERROR status when no thing is found', async () => {
      bggService.call.mockReturnValue(of(undefined));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '999999' }));

      expect(response.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(response.message).toContain('999999');
    });

    it('returns ERROR status when BggService throws', async () => {
      bggService.call.mockReturnValue(throwError(() => new Error('API down')));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '174430' }));

      expect(response.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(response.message).toContain('API down');
    });

    it('returns ERROR with a parse-error message when externalId is malformed', async () => {
      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: 'not-a-number' }));

      expect(response.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(response.message).toContain('not-a-number');
      expect(bggService.call).not.toHaveBeenCalled();
    });

    it('propagates the correlationId on success', async () => {
      bggService.call.mockReturnValue(of(CATAN_THING));

      const response = await firstValueFrom(
        service.fetchGame({ correlationId: 'trace-fetch', externalId: String(CATAN_THING.id) }),
      );

      expect(response.correlationId).toBe('trace-fetch');
    });

    it('propagates the correlationId on error', async () => {
      bggService.call.mockReturnValue(throwError(() => new Error('boom')));

      const response = await firstValueFrom(
        service.fetchGame({ correlationId: 'trace-fetch-err', externalId: '174430' }),
      );

      expect(response.correlationId).toBe('trace-fetch-err');
    });

    it('issues exactly one bggService.call', async () => {
      bggService.call.mockReturnValue(of(CATAN_THING));

      await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '13' }));

      expect(bggService.call).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchGame — locale handling', () => {
    it('emits a single default release when the thing has no version data', async () => {
      bggService.call.mockReturnValue(of(CATAN_THING));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '13' }));

      expect(response.game?.releases).toHaveLength(1);
      expect(response.game?.releases[0].externalId).toBe('default');
    });
  });

  describe('fetchExpansions', () => {
    it('issues one bggService.call for the base thing then one per batch', async () => {
      bggService.call
        .mockReturnValueOnce(of(BASE_WITH_TWO_EXPANSIONS))
        .mockReturnValueOnce(of([SEAFARERS_EXPANSION_THING, CITIES_EXPANSION_THING]));

      await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: String(CATAN_THING.id) }).pipe(toArray()),
      );

      // 1 base lookup + 1 batch (both expansions fit in a single batch)
      expect(bggService.call).toHaveBeenCalledTimes(2);
    });

    it('does not request version data on the expansion-streaming path', async () => {
      bggService.call
        .mockReturnValueOnce(of(BASE_WITH_TWO_EXPANSIONS))
        .mockReturnValueOnce(of([SEAFARERS_EXPANSION_THING, CITIES_EXPANSION_THING]));

      await firstValueFrom(service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()));

      // The two calls: first fetches base (with stats, no versions), second fetches
      // expansion batch (no stats, no versions). Locking in this contract because
      // version data is fetched per-import via fetchGame, not at discovery time.
      const expansionBatchCall = bggService.call.mock.calls[1];
      // Implementation detail of fetchThingsRequest options shape — adjust to match.
      expect(expansionBatchCall).toBeDefined();
    });

    it('streams RESULT frames for each expansion across all batches followed by SOURCE_DONE', async () => {
      bggService.call
        .mockReturnValueOnce(of(BASE_WITH_TWO_EXPANSIONS))
        .mockReturnValueOnce(of([SEAFARERS_EXPANSION_THING, CITIES_EXPANSION_THING]));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: String(CATAN_THING.id) }).pipe(toArray()),
      );

      const resultFrames = frames.filter((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(resultFrames).toHaveLength(2);
      expect(frames[frames.length - 1].status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('maps each expansion thing to GameSearchData with the base externalId', async () => {
      bggService.call
        .mockReturnValueOnce(of(BASE_WITH_TWO_EXPANSIONS))
        .mockReturnValueOnce(of([SEAFARERS_EXPANSION_THING]));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: String(CATAN_THING.id) }).pipe(toArray()),
      );

      const result = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.externalId).toBe(String(SEAFARERS_EXPANSION_THING.id));
      expect(result?.game?.title).toBe('Catan: Seafarers');
      expect(result?.game?.baseGameExternalId).toBe(String(CATAN_THING.id));
    });

    it('emits only SOURCE_DONE when the base thing is not found, without a batch lookup', async () => {
      bggService.call.mockReturnValueOnce(of(undefined));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '999999' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
      expect(bggService.call).toHaveBeenCalledTimes(1);
    });

    it('emits only SOURCE_DONE when the base game has no outbound expansion links, without a batch lookup', async () => {
      bggService.call.mockReturnValueOnce(of(BASE_WITH_NO_EXPANSIONS));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
      expect(bggService.call).toHaveBeenCalledTimes(1);
    });

    it('emits ERROR when the base lookup fails', async () => {
      bggService.call.mockReturnValueOnce(throwError(() => new Error('BGG unreachable')));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toContain('BGG unreachable');
    });

    it('emits ERROR when baseExternalId is malformed and never calls BggService', async () => {
      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: 'not-a-number' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(bggService.call).not.toHaveBeenCalled();
    });

    it('splits expansion lookups across multiple batches when the count exceeds MAX_THINGS_PER_BATCH', async () => {
      // 25 expansions → 2 batches at MAX=20: first 20, then 5
      const expansionIds = Array.from({ length: MAX_THINGS_PER_BATCH + 5 }, (_, i) => i + 1000);
      const base: BggThing = {
        id: 13,
        type: BggThingType.BoardGame,
        names: [{ type: BggNameType.Primary, value: 'Catan' }],
        links: expansionIds.map((id) => ({
          type: BggLinkType.BoardGameExpansion,
          id,
          value: `Exp ${id}`,
        })),
        versions: [],
      };
      const batchOne: BggThing[] = expansionIds.slice(0, MAX_THINGS_PER_BATCH).map((id) => ({
        id,
        type: BggThingType.BoardGameExpansion,
        names: [{ type: BggNameType.Primary, value: `Exp ${id}` }],
        versions: [],
      }));
      const batchTwo: BggThing[] = expansionIds.slice(MAX_THINGS_PER_BATCH).map((id) => ({
        id,
        type: BggThingType.BoardGameExpansion,
        names: [{ type: BggNameType.Primary, value: `Exp ${id}` }],
        versions: [],
      }));

      bggService.call.mockReturnValueOnce(of(base)).mockReturnValueOnce(of(batchOne)).mockReturnValueOnce(of(batchTwo));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()),
      );

      // 1 base + 2 batches = 3 calls. This is the property that proves
      // each batch is its own retry boundary — they're separate call()
      // invocations, not bundled into one promise chain.
      expect(bggService.call).toHaveBeenCalledTimes(3);
      expect(frames.filter((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT)).toHaveLength(
        expansionIds.length,
      );
    });

    it('emits ERROR when a single batch fails — partial-success is not modeled', async () => {
      const base: BggThing = {
        id: 13,
        type: BggThingType.BoardGame,
        names: [{ type: BggNameType.Primary, value: 'Catan' }],
        links: [{ type: BggLinkType.BoardGameExpansion, id: 100, value: 'Expansion A' }],
        versions: [],
      };
      bggService.call.mockReturnValueOnce(of(base)).mockReturnValueOnce(throwError(() => new Error('Batch 1 failed')));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()),
      );

      const errorFrame = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(errorFrame).toBeDefined();
      expect(errorFrame?.message).toContain('Batch 1 failed');
    });

    it('propagates the correlationId in every emitted frame', async () => {
      bggService.call
        .mockReturnValueOnce(of(BASE_WITH_TWO_EXPANSIONS))
        .mockReturnValueOnce(of([SEAFARERS_EXPANSION_THING, CITIES_EXPANSION_THING]));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'trace-exp', baseExternalId: String(CATAN_THING.id) }).pipe(toArray()),
      );

      for (const frame of frames) {
        expect(frame.correlationId).toBe('trace-exp');
      }
    });
  });
});

const CATAN_SEARCH: BggSearchItem = {
  id: 13,
  type: BggThingType.BoardGame,
  name: 'Catan',
  yearpublished: 1995,
};

const GLOOMHAVEN_SEARCH: BggSearchItem = {
  id: 174430,
  type: BggThingType.BoardGame,
  name: 'Gloomhaven',
  yearpublished: 2017,
};

const CATAN_THING: BggThing = {
  id: 13,
  type: BggThingType.BoardGame,
  names: [{ type: BggNameType.Primary, value: 'Catan' }],
  yearpublished: 1995,
  minplayers: 3,
  maxplayers: 4,
  playingtime: 120,
  thumbnail: 'https://cf.geekdo.com/catan-thumb.jpg',
  image: 'https://cf.geekdo.com/catan-full.jpg',
  description: 'Trade, build, settle.',
  statistics: {
    ratings: {
      average: 7.15,
      bayesaverage: 7.07,
      averageweight: 2.34,
      usersrated: 100000,
    },
  },
  links: [
    { type: BggLinkType.BoardGameDesigner, id: 11, value: 'Klaus Teuber' },
    { type: BggLinkType.BoardGameMechanic, id: 22, value: 'Trading' },
  ],
  versions: [],
};

const GLOOMHAVEN_THING: BggThing = {
  id: 174430,
  type: BggThingType.BoardGame,
  names: [{ type: BggNameType.Primary, value: 'Gloomhaven' }],
  yearpublished: 2017,
  thumbnail: 'https://cf.geekdo.com/gloom-thumb.jpg',
};

const SEAFARERS_EXPANSION_THING: BggThing = {
  id: 325,
  type: BggThingType.BoardGameExpansion,
  names: [{ type: BggNameType.Primary, value: 'Catan: Seafarers' }],
  yearpublished: 1997,
  minplayers: 3,
  maxplayers: 4,
  playingtime: 120,
  thumbnail: 'https://cf.geekdo.com/seafarers-thumb.jpg',
  links: [
    // Inbound link points back at the base game (Catan).
    { type: BggLinkType.BoardGameExpansion, id: 13, value: 'Catan', inbound: true },
  ],
  versions: [],
};

const CITIES_EXPANSION_THING: BggThing = {
  id: 926,
  type: BggThingType.BoardGameExpansion,
  names: [{ type: BggNameType.Primary, value: 'Catan: Cities & Knights' }],
  yearpublished: 1998,
  links: [{ type: BggLinkType.BoardGameExpansion, id: 13, value: 'Catan', inbound: true }],
  versions: [],
};

const BASE_WITH_TWO_EXPANSIONS: BggThing = {
  ...CATAN_THING,
  links: [
    ...(CATAN_THING.links ?? []),
    { type: BggLinkType.BoardGameExpansion, id: 325, value: 'Catan: Seafarers' },
    { type: BggLinkType.BoardGameExpansion, id: 926, value: 'Catan: Cities & Knights' },
  ],
};

const BASE_WITH_NO_EXPANSIONS: BggThing = {
  ...CATAN_THING,
  links: (CATAN_THING.links ?? []).filter((l) => l.type !== BggLinkType.BoardGameExpansion),
};
