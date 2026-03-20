import {
  ContentType,
  FetchExpansionsRequest,
  FetchGameRequest,
  GatewayPingRequest,
  GatewaySearchRequest,
  HealthCheckRequest,
  HealthCheckResponse_ServingStatus,
  ResultStatus,
} from '@board-games-empire/proto-gateway';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { IGDB_CLIENT } from '../igdb/constants';
import { IgdbGame } from '../types';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayService', () => {
  let service: GameGatewayService;
  let mockIgdbClient: MockIgdbApiClient;

  beforeEach(async () => {
    mockIgdbClient = buildMockIgdbClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [GameGatewayService, { provide: IGDB_CLIENT, useValue: mockIgdbClient }],
    }).compile();

    service = module.get<GameGatewayService>(GameGatewayService);
  });

  describe('ping', () => {
    it('returns a response using the correlationId from the request', () => {
      const request: GatewayPingRequest = { correlationId: 'corr-ping-1' };
      const response = service.ping(request);

      expect(response.correlationId).toBe('corr-ping-1');
    });

    it('generates a correlationId when none is provided in the request', () => {
      const request: GatewayPingRequest = {};
      const response = service.ping(request);

      expect(response.correlationId).toBeTruthy();
      expect(typeof response.correlationId).toBe('string');
    });

    it('returns the gateway name "IgdbGateway"', () => {
      const response = service.ping({});
      expect(response.gatewayName).toBe('IgdbGateway');
    });

    it('includes "GatewayService" in supportedServices', () => {
      const response = service.ping({});
      expect(response.supportedServices).toContain('GatewayService');
    });

    it('returns a bigint timestampMs', () => {
      const response = service.ping({});
      expect(typeof response.timestampMs).toBe('bigint');
    });
  });

  describe('healthCheck', () => {
    it('returns SERVING status', () => {
      const request: HealthCheckRequest = { service: 'GatewayService' };
      const response = service.healthCheck(request);

      expect(response.status).toBe(HealthCheckResponse_ServingStatus.SERVING);
    });
  });

  describe('searchGames', () => {
    it('emits one RESULT frame per game followed by a single SOURCE_DONE', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME, DLC_GAME] });

      const request: GatewaySearchRequest = { correlationId: 'c', query: 'Hades' };
      const frames = await firstValueFrom(service.searchGames(request).pipe(toArray()));

      const resultFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);
      const doneFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_SOURCE_DONE);

      expect(resultFrames).toHaveLength(2);
      expect(doneFrames).toHaveLength(1);
      // SOURCE_DONE must be the terminal frame
      expect(frames[frames.length - 1].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('emits only SOURCE_DONE when IGDB returns no results', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [] });

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'nonexistent' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('maps the IGDB id to externalId as a string', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const resultFrame = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(resultFrame?.game?.externalId).toBe(String(BASE_GAME.id));
    });

    it('maps IGDB category 0 (main_game) → CONTENT_TYPE_BASE_GAME', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [{ ...BASE_GAME, category: 0 }] });

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'test' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.contentType).toBe(ContentType.CONTENT_TYPE_BASE_GAME);
    });

    it('maps IGDB category 1 (dlc_addon) → CONTENT_TYPE_DLC', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [DLC_GAME] });

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'dlc' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.contentType).toBe(ContentType.CONTENT_TYPE_DLC);
    });

    it('maps IGDB category 2 (expansion) → CONTENT_TYPE_EXPANSION', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [EXPANSION_GAME] });

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'expansion' }).pipe(toArray()),
      );
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.contentType).toBe(ContentType.CONTENT_TYPE_EXPANSION);
    });

    it('maps IGDB category 4 (standalone_expansion) → CONTENT_TYPE_STANDALONE_EXPANSION', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [STANDALONE_EXPANSION] });

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'standalone' }).pipe(toArray()),
      );
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.contentType).toBe(ContentType.CONTENT_TYPE_STANDALONE_EXPANSION);
    });

    it('maps IGDB category 3 (bundle) → CONTENT_TYPE_UNSPECIFIED', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BUNDLE_GAME] });

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'bundle' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.contentType).toBe(ContentType.CONTENT_TYPE_UNSPECIFIED);
    });

    it('prefixes protocol-relative cover URLs with "https:"', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.thumbnailUrl).toMatch(/^https:/);
      expect(result?.game?.thumbnailUrl).not.toMatch(/^\/\//);
    });

    it('sets baseGameExternalId from parent_game for DLC games', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [DLC_GAME] });

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'dlc' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBe(String(DLC_GAME.parent_game?.id));
    });

    it('sets baseGameExternalId from version_parent for standalone expansions', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [STANDALONE_EXPANSION] });

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'standalone' }).pipe(toArray()),
      );
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBe(String(STANDALONE_EXPANSION.version_parent!.id));
    });

    it('does not set baseGameExternalId for base games', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBeUndefined();
    });

    it('forwards limit and offset to the IGDB query when provided', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [] });

      await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'test', limit: 5, offset: 10 }).pipe(toArray()),
      );

      expect(mockIgdbClient.limit).toHaveBeenCalledWith(5);
      expect(mockIgdbClient.offset).toHaveBeenCalledWith(10);
    });

    it('propagates the correlationId in every emitted frame', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'trace-abc', query: 'Hades' }).pipe(toArray()),
      );

      for (const frame of frames) {
        expect(frame.correlationId).toBe('trace-abc');
      }
    });

    it('emits a single ERROR frame and does not throw when the IGDB API rejects', async () => {
      mockIgdbClient.request.mockRejectedValue(new Error('IGDB unavailable'));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'corr-err', query: 'Hades' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].correlationId).toBe('corr-err');
      expect(frames[0].message).toContain('IGDB unavailable');
    });
  });

  describe('fetchGame', () => {
    it('returns a response with RESULT status and populated GameData', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const request: FetchGameRequest = { correlationId: 'c', externalId: '1942' };
      const response = await firstValueFrom(service.fetchGame(request));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_RESULT);
      expect(response.game).toBeDefined();
      expect(response.game?.externalId).toBe('1942');
      expect(response.game?.title).toBe('Hades');
      expect(response.correlationId).toBe('c');
    });

    it('derives yearPublished from first_release_date unix timestamp', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      // BASE_GAME.first_release_date = 1600905600 → year 2020
      expect(response.game?.yearPublished).toBe(2020);
    });

    it('prefixes protocol-relative cover URL with "https:" for both thumbnailUrl and imageUrl', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      expect(response.game?.thumbnailUrl).toMatch(/^https:/);
      expect(response.game?.imageUrl).toMatch(/^https:/);
    });

    it('maps only publisher companies to publishers[]', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      // Both Supergiant and Private Division are publishers
      expect(response.game?.publishers).toHaveLength(2);
      const names = response.game?.publishers.map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(['Supergiant Games', 'Private Division']));
    });

    it('maps only developer companies to designers[]', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      // Only Supergiant Games is a developer; Private Division is publisher-only
      const names = response.game?.designers.map((d) => d.name);
      expect(names).toContain('Supergiant Games');
      expect(names).not.toContain('Private Division');
    });

    it('uses company id as externalId for publishers and designers', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      const publisherIds = response.game?.publishers.map((p) => p.externalId);
      expect(publisherIds).toContain(String(BASE_GAME.involved_companies?.[0].company.id));
    });

    it('merges genres and themes into categories[]', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      const names = response.game?.categories.map((c) => c.name);
      // genres: Adventure, Indie; themes: Action
      expect(names).toEqual(expect.arrayContaining(['Adventure', 'Indie', 'Action']));
    });

    it('merges franchises and collections into families[]', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      const names = response.game?.families.map((f) => f.name);
      expect(names).toEqual(expect.arrayContaining(['Hades Series', 'Supergiant Collection']));
    });

    it('maps total_rating → averageRating and total_rating_count → ratingsCount', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      expect(response.game?.averageRating).toBe(BASE_GAME.total_rating);
      expect(response.game?.ratingsCount).toBe(BASE_GAME.total_rating_count);
    });

    it('maps summary → description', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      expect(response.game?.description).toBe(BASE_GAME.summary);
    });

    it('sets baseGameExternalId from parent_game when fetching a DLC', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [DLC_GAME] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '9001' }));

      expect(response.game?.baseGameExternalId).toBe(String(DLC_GAME.parent_game?.id));
    });

    it('queries IGDB using the externalId as a numeric where clause', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [BASE_GAME] });

      await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '1942' }));

      expect(mockIgdbClient.where).toHaveBeenCalledWith(expect.stringContaining('1942'));
    });

    it('returns ERROR status with no game when IGDB returns an empty result set', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [] });

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '9999' }));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(response.game).toBeUndefined();
      expect(response.message).toBeDefined();
    });

    it('returns ERROR status and does not throw when the IGDB API rejects', async () => {
      mockIgdbClient.request.mockRejectedValue(new Error('network timeout'));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'corr-err', externalId: '1942' }));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(response.correlationId).toBe('corr-err');
      expect(response.message).toContain('network timeout');
    });
  });

  // ── fetchExpansions ────────────────────────────────────────────────────────
  //
  // Implementation assumption: a single IGDB query using the filter
  //   `parent_game = {baseExternalId} | version_parent = {baseExternalId}`
  // captures DLCs (category 1), expansions (category 2), and standalone
  // expansions (category 4) in one round trip.

  describe('fetchExpansions', () => {
    it('emits one RESULT frame per expansion/DLC followed by SOURCE_DONE', async () => {
      mockIgdbClient.request.mockResolvedValue({
        data: [DLC_GAME, EXPANSION_GAME, STANDALONE_EXPANSION],
      });

      const request: FetchExpansionsRequest = { correlationId: 'c', baseExternalId: '1942' };
      const frames = await firstValueFrom(service.fetchExpansions(request).pipe(toArray()));

      const resultFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);
      const doneFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_SOURCE_DONE);

      expect(resultFrames).toHaveLength(3);
      expect(doneFrames).toHaveLength(1);
      expect(frames[frames.length - 1].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('emits only SOURCE_DONE when the base game has no expansions or DLCs', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [] });

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '1942' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('queries IGDB using both parent_game and version_parent with the given baseExternalId', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [] });

      await firstValueFrom(service.fetchExpansions({ correlationId: 'c', baseExternalId: '1942' }).pipe(toArray()));

      expect(mockIgdbClient.where).toHaveBeenCalledWith(expect.stringContaining('1942'));
    });

    it('result frames carry lean GameSearchData (no full GameData fields)', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [DLC_GAME] });

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '1942' }).pipe(toArray()),
      );
      const resultFrame = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(resultFrame?.game).toBeDefined();
      expect(resultFrame?.game?.externalId).toBe(String(DLC_GAME.id));
      expect(resultFrame?.game?.title).toBe(DLC_GAME.name);
    });

    it('propagates the correlationId in all frames', async () => {
      mockIgdbClient.request.mockResolvedValue({ data: [DLC_GAME] });

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'trace-xyz', baseExternalId: '1942' }).pipe(toArray()),
      );

      for (const frame of frames) {
        expect(frame.correlationId).toBe('trace-xyz');
      }
    });

    it('emits a single ERROR frame and does not throw when the IGDB API rejects', async () => {
      mockIgdbClient.request.mockRejectedValue(new Error('rate limited'));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'corr-err', baseExternalId: '1942' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].correlationId).toBe('corr-err');
      expect(frames[0].message).toContain('rate limited');
    });
  });
});

interface MockIgdbApiClient {
  fields: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
  search: jest.Mock;
  where: jest.Mock;
  sort: jest.Mock;
  request: jest.Mock<Promise<{ data: IgdbGame[] }>>;
}

function buildMockIgdbClient(): MockIgdbApiClient {
  const client = {
    fields: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    search: jest.fn(),
    where: jest.fn(),
    sort: jest.fn(),
    request: jest.fn<Promise<{ data: IgdbGame[] }>, [string]>(),
  };

  // Each chain method must return the same client so `.fields(...).search(...).request(...)` works.
  client.fields.mockReturnValue(client);
  client.limit.mockReturnValue(client);
  client.offset.mockReturnValue(client);
  client.search.mockReturnValue(client);
  client.where.mockReturnValue(client);
  client.sort.mockReturnValue(client);

  return client;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_GAME: IgdbGame = {
  id: 1942,
  name: 'Hades',
  category: 0,
  first_release_date: 1600905600, // 2020-09-24
  cover: { id: 100, url: '//images.igdb.com/igdb/image/upload/t_cover_big/hades.jpg' },
  url: 'https://www.igdb.com/games/hades',
  total_rating: 91.5,
  total_rating_count: 500,
  summary: 'A rogue-like dungeon crawler in the Underworld.',
  involved_companies: [
    {
      id: 1,
      company: { id: 10, name: 'Supergiant Games', websites: [{ url: 'https://www.supergiantgames.com' }] },
      developer: true,
      publisher: true,
    },
    {
      id: 2,
      company: { id: 11, name: 'Private Division' },
      developer: false,
      publisher: true,
    },
  ],
  genres: [
    { id: 31, name: 'Adventure' },
    { id: 32, name: 'Indie' },
  ],
  themes: [{ id: 1, name: 'Action' }],
  franchises: [{ id: 5, name: 'Hades Series' }],
  collections: [{ id: 50, name: 'Supergiant Collection' }],
};

const DLC_GAME: IgdbGame = {
  id: 9001,
  name: 'Hades - Extra Weapons Pack',
  category: 1, // dlc_addon
  parent_game: { id: 1942 },
  cover: { id: 101, url: '//images.igdb.com/igdb/image/upload/t_cover_big/hades-dlc.jpg' },
};

const EXPANSION_GAME: IgdbGame = {
  id: 9002,
  name: 'Hades: Underworld Chronicles',
  category: 2, // expansion
  parent_game: { id: 1942 },
};

const STANDALONE_EXPANSION: IgdbGame = {
  id: 9003,
  name: 'Hades: Standalone Chapter',
  category: 4, // standalone_expansion
  version_parent: { id: 1942 },
};

const BUNDLE_GAME: IgdbGame = {
  id: 9004,
  name: 'Supergiant Complete Pack',
  category: 3, // bundle — no direct ContentType mapping
};
