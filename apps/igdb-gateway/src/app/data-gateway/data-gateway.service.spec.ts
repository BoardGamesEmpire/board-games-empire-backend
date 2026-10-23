import { BGE_VERSION } from '@bge/version';
import * as proto from '@boardgamesempire/proto-gateway';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { IGDBService, type IgdbRequest } from '../igdb/igdb.service';
import { IgdbGame } from '../types';
import { DataGatewayService } from './data-gateway.service';

// ---------------------------------------------------------------------------
// Mock IGDBService to isolate DataGatewayService tests and avoid real API calls. We only need to
// mock the 'call' method since that's what DataGatewayService uses.
// ---------------------------------------------------------------------------
function buildMockIgdbService(): jest.Mocked<Pick<IGDBService, 'call'>> {
  return { call: jest.fn() };
}

describe('DataGatewayService', () => {
  let service: DataGatewayService;
  let igdbService: jest.Mocked<Pick<IGDBService, 'call'>>;

  beforeEach(async () => {
    igdbService = buildMockIgdbService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [DataGatewayService, { provide: IGDBService, useValue: igdbService }],
    }).compile();

    service = module.get<DataGatewayService>(DataGatewayService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('ping', () => {
    it('returns a response using the correlationId from the request', () => {
      const request: proto.GatewayPingRequest = { correlationId: 'corr-ping-1' };
      const response = service.ping(request);
      expect(response.correlationId).toBe('corr-ping-1');
    });

    it('generates a correlationId when none is provided in the request', () => {
      const response = service.ping({});
      expect(response.correlationId).toBeTruthy();
      expect(typeof response.correlationId).toBe('string');
    });

    it('returns the gateway name "IgdbGateway"', () => {
      expect(service.ping({}).gatewayName).toBe('IgdbGateway');
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

    it('declares search, fetch, fetch expansions and the lists of languages, platforms and categories', () => {
      expect(new Set(service.describe({}).capabilities)).toEqual(
        new Set([
          proto.Capability.CAPABILITY_SEARCH,
          proto.Capability.CAPABILITY_FETCH,
          proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
          proto.Capability.CAPABILITY_LIST_LANGUAGES,
          proto.Capability.CAPABILITY_LIST_PLATFORMS,
          proto.Capability.CAPABILITY_LIST_CATEGORIES,
        ]),
      );
    });

    // IGDB has no mechanics to list (#718).
    it('declares list platforms and list categories, but not list mechanics', () => {
      const { capabilities } = service.describe({});

      expect(capabilities).toEqual(
        expect.arrayContaining([
          proto.Capability.CAPABILITY_LIST_PLATFORMS,
          proto.Capability.CAPABILITY_LIST_CATEGORIES,
        ]),
      );
      expect(capabilities).not.toContain(proto.Capability.CAPABILITY_LIST_MECHANICS);
    });

    it('covers every video platform type, never tabletop', () => {
      expect(new Set(service.describe({}).coverage?.platformTypes)).toEqual(
        new Set([
          proto.PlatformType.PLATFORM_TYPE_CONSOLE,
          proto.PlatformType.PLATFORM_TYPE_PC,
          proto.PlatformType.PLATFORM_TYPE_PORTABLE,
          proto.PlatformType.PLATFORM_TYPE_MOBILE,
          proto.PlatformType.PLATFORM_TYPE_ARCADE,
          proto.PlatformType.PLATFORM_TYPE_OTHER,
        ]),
      );
    });

    it('covers every content type its game types map to, and no accessories', () => {
      expect(new Set(service.describe({}).coverage?.contentTypes)).toEqual(
        new Set([
          proto.ContentType.CONTENT_TYPE_BASE_GAME,
          proto.ContentType.CONTENT_TYPE_EXPANSION,
          proto.ContentType.CONTENT_TYPE_DLC,
          proto.ContentType.CONTENT_TYPE_STANDALONE_EXPANSION,
          proto.ContentType.CONTENT_TYPE_BUNDLE,
          proto.ContentType.CONTENT_TYPE_REMAKE,
          proto.ContentType.CONTENT_TYPE_REMASTER,
          proto.ContentType.CONTENT_TYPE_EXPANDED_EDITION,
          proto.ContentType.CONTENT_TYPE_PORT,
          proto.ContentType.CONTENT_TYPE_MOD,
        ]),
      );
    });

    it('declares publish year with platform type and content type', () => {
      expect(service.describe({}).filterableAxes).toEqual([
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PLATFORM_TYPE,
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE,
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR,
      ]);
    });

    it('accepts BCP 47 tags before ISO 639-1 codes, sends BCP 47 tags, and wants the search language translated', () => {
      expect(service.describe({}).languageCodeFormats).toEqual({
        acceptedRequestFormats: [
          proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
          proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_ISO_639_1,
        ],
        responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
        passthroughSearchLanguage: false,
      } satisfies proto.LanguageCodeFormats);
    });

    it('declares its free text as plain text', () => {
      expect(service.describe({}).contentFormat).toBe(proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT);
    });
  });

  describe('the lists (#718)', () => {
    /** The offset a request asks IGDB from, read by running it against a recording client. */
    const offsetOf = async (request: IgdbRequest<unknown>): Promise<number> => {
      const offset = jest.fn();
      const client = new Proxy(
        {},
        {
          get: (_target, key) =>
            key === 'request'
              ? () => Promise.resolve({ data: [] })
              : (...args: unknown[]) => {
                  if (key === 'offset') {
                    offset(...args);
                  }
                  return client;
                },
        },
      );
      await request(client as never);
      return offset.mock.calls[0]?.[0];
    };

    const platform = (id: number) => ({ id, name: `Platform ${id}`, platform_type: 1 });

    it('lists every platform, page by page, until a page comes back short (#718)', async () => {
      const full = Array.from({ length: 500 }, (_, index) => platform(index + 1));
      const short = [platform(501), platform(502), platform(503)];
      igdbService.call.mockReturnValueOnce(of(full)).mockReturnValueOnce(of(short));

      const response = await firstValueFrom(service.listPlatforms({ correlationId: 'corr-platforms' }));

      expect(response.correlationId).toBe('corr-platforms');
      expect(response.platforms).toHaveLength(503);
      expect(response.platforms[502]).toMatchObject({ externalId: '503', name: 'Platform 503' });
      expect(igdbService.call).toHaveBeenCalledTimes(2);
      const [[first], [second]] = igdbService.call.mock.calls as [IgdbRequest<unknown>][];
      await expect(offsetOf(first)).resolves.toBe(0);
      await expect(offsetOf(second)).resolves.toBe(500);
    });

    it('asks once when the first page comes back short', async () => {
      igdbService.call.mockReturnValueOnce(of([platform(1)]));

      const response = await firstValueFrom(service.listPlatforms({}));

      expect(response.platforms).toHaveLength(1);
      expect(igdbService.call).toHaveBeenCalledTimes(1);
    });

    it('maps a listed platform as a game’s platform is mapped', async () => {
      igdbService.call.mockReturnValueOnce(of([{ id: 39, name: 'iOS', abbreviation: 'iOS', platform_type: 4 }]));

      const response = await firstValueFrom(service.listPlatforms({}));

      expect(response.platforms).toEqual([
        { externalId: '39', name: 'iOS', abbreviation: 'iOS', platformType: proto.PlatformType.PLATFORM_TYPE_MOBILE },
      ]);
    });

    it('lists IGDB’s genres as its categories', async () => {
      igdbService.call.mockReturnValueOnce(
        of([
          { id: 15, name: 'Strategy' },
          { id: 16, name: 'Turn-based strategy (TBS)' },
        ]),
      );

      const response = await firstValueFrom(service.listCategories({ correlationId: 'corr-categories' }));

      expect(response).toEqual({
        correlationId: 'corr-categories',
        categories: [
          { externalId: '15', name: 'Strategy' },
          { externalId: '16', name: 'Turn-based strategy (TBS)' },
        ],
      });
    });

    it('fails the list when IGDB fails, rather than answering part of it', async () => {
      const full = Array.from({ length: 500 }, (_, index) => platform(index + 1));
      igdbService.call.mockReturnValueOnce(of(full)).mockReturnValueOnce(throwError(() => new Error('IGDB 503')));

      await expect(firstValueFrom(service.listPlatforms({}))).rejects.toThrow('IGDB 503');
    });
  });

  describe('healthCheck', () => {
    it('returns SERVING status', () => {
      const request: proto.HealthCheckRequest = { service: 'GatewayService' };
      expect(service.healthCheck(request).status).toBe(proto.HealthCheckResponse_ServingStatus.SERVING);
    });
  });

  describe('searchGames', () => {
    it('narrows the IGDB query by the request’s filter', async () => {
      igdbService.call.mockReturnValue(of([]));
      await firstValueFrom(
        service
          .searchGames({
            correlationId: 'c',
            query: 'Hades',
            filter: {
              platformTypes: [proto.PlatformType.PLATFORM_TYPE_CONSOLE],
              contentTypes: [proto.ContentType.CONTENT_TYPE_EXPANSION],
            },
          })
          .pipe(toArray()),
      );

      const where = jest.fn().mockReturnThis();
      const client = {
        fields: jest.fn().mockReturnThis(),
        search: jest.fn().mockReturnThis(),
        where,
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        request: jest.fn().mockResolvedValue({ data: [] }),
      };
      const [igdbRequest] = igdbService.call.mock.calls[0] as unknown as [IgdbRequest<IgdbGame[]>];
      await igdbRequest(client as never);

      expect(where).toHaveBeenCalledWith(expect.stringContaining('game_type = (2) & platforms.platform_type = (1)'));
    });

    it('ends at once, without asking IGDB, when the filter names nothing IGDB has', async () => {
      const frames = await firstValueFrom(
        service
          .searchGames({
            correlationId: 'c',
            query: 'Catan',
            filter: { platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP], contentTypes: [] },
          })
          .pipe(toArray()),
      );

      expect(frames).toEqual([{ correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE }]);
      expect(igdbService.call).not.toHaveBeenCalled();
    });

    it('emits one RESULT frame per game followed by a single SOURCE_DONE', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME, DLC_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));

      const resultFrames = frames.filter((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);
      const doneFrames = frames.filter((f) => f.status === proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);

      expect(resultFrames).toHaveLength(2);
      expect(doneFrames).toHaveLength(1);
      expect(frames[frames.length - 1].status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('emits only SOURCE_DONE when IGDB returns no results', async () => {
      igdbService.call.mockReturnValue(of([]));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'nonexistent' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('maps the IGDB id to externalId as a string', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const resultFrame = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(resultFrame?.game?.externalId).toBe(String(BASE_GAME.id));
    });

    it('propagates the correlationId in every emitted frame', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'trace-abc', query: 'Hades' }).pipe(toArray()),
      );

      for (const frame of frames) {
        expect(frame.correlationId).toBe('trace-abc');
      }
    });

    it('emits a single ERROR frame and does not throw when IGDBService rejects', async () => {
      igdbService.call.mockReturnValue(throwError(() => new Error('IGDB unavailable')));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'corr-err', query: 'Hades' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toContain('IGDB unavailable');
    });

    it('prefixes protocol-relative cover URLs with "https:"', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const result = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.thumbnailUrl).toMatch(/^https:/);
      expect(result?.game?.thumbnailUrl).not.toMatch(/^\/\//);
    });

    it('sets baseGameExternalId from parent_game for DLC games', async () => {
      igdbService.call.mockReturnValue(of([DLC_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'dlc' }).pipe(toArray()));
      const result = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBe(String(DLC_GAME.parent_game));
    });

    it('sets baseGameExternalId from version_parent for standalone expansions', async () => {
      igdbService.call.mockReturnValue(of([STANDALONE_EXPANSION]));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'standalone' }).pipe(toArray()),
      );
      const result = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBe(String(STANDALONE_EXPANSION.version_parent));
    });

    it('does not set baseGameExternalId for base games', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const result = frames.find((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBeUndefined();
    });
  });

  describe('fetchGame', () => {
    it('returns RESULT status with populated game data', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: String(BASE_GAME.id) };
      const response = await firstValueFrom(service.fetchGame(request));

      expect(response.status).toBe(proto.ResultStatus.RESULT_STATUS_RESULT);
      expect(response.game?.externalId).toBe(String(BASE_GAME.id));
      expect(response.correlationId).toBe('c');
    });

    it('returns ERROR status when no game is found', async () => {
      igdbService.call.mockReturnValue(of([]));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '9999' }));

      expect(response.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
    });

    it('returns ERROR status when IGDBService throws', async () => {
      igdbService.call.mockReturnValue(throwError(() => new Error('API down')));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '9999' }));

      expect(response.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(response.message).toContain('API down');
    });
  });

  describe('fetchExpansions', () => {
    it('streams RESULT frames for each expansion followed by SOURCE_DONE', async () => {
      igdbService.call.mockReturnValue(of([DLC_GAME]));

      const request: proto.FetchExpansionsRequest = { correlationId: 'c', baseExternalId: String(BASE_GAME.id) };
      const frames = await firstValueFrom(service.fetchExpansions(request).pipe(toArray()));

      expect(frames.filter((f) => f.status === proto.ResultStatus.RESULT_STATUS_RESULT)).toHaveLength(1);
      expect(frames[frames.length - 1].status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('emits an ERROR frame when IGDBService throws', async () => {
      igdbService.call.mockReturnValue(throwError(() => new Error('IGDB unreachable')));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '1942' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toContain('IGDB unreachable');
    });
  });
});

// Fixtures - TODO: more extensive
const BASE_GAME: IgdbGame = {
  id: 1942,
  name: 'Hades',
  game_type: 0,
  first_release_date: 1577836800,
  total_rating: 91,
  cover: {
    id: 12345,
    url: '//images.igdb.com/igdb/image/upload/t_cover_big/co4rs3.jpg',
  },
  url: 'https://www.igdb.com/games/hades',
  platforms: [],
  genres: [],
  themes: [],
  involved_companies: [],
};

const DLC_GAME: IgdbGame = {
  id: 9001,
  name: 'Hades – Extra Weapons Pack',
  game_type: 1,
  parent_game: 1942,
  platforms: [],
  genres: [],
  themes: [],
  involved_companies: [],
};

const STANDALONE_EXPANSION: IgdbGame = {
  id: 9002,
  name: 'Hades Standalone',
  game_type: 4,
  version_parent: 1942,
  platforms: [],
  genres: [],
  themes: [],
  involved_companies: [],
};
