import {
  FetchExpansionsRequest,
  FetchGameRequest,
  GatewayPingRequest,
  HealthCheckRequest,
  HealthCheckResponse_ServingStatus,
  ResultStatus,
} from '@board-games-empire/proto-gateway';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { IGDBService } from '../igdb/igdb.service';
import { IgdbGame } from '../types';
import { GameGatewayService } from './game-gateway.service';

// ---------------------------------------------------------------------------
// Mock IGDBService to isolate GameGatewayService tests and avoid real API calls. We only need to
// mock the 'call' method since that's what GameGatewayService uses.
// ---------------------------------------------------------------------------
function buildMockIgdbService(): jest.Mocked<Pick<IGDBService, 'call'>> {
  return { call: jest.fn() };
}

describe('GameGatewayService', () => {
  let service: GameGatewayService;
  let igdbService: jest.Mocked<Pick<IGDBService, 'call'>>;

  beforeEach(async () => {
    igdbService = buildMockIgdbService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [GameGatewayService, { provide: IGDBService, useValue: igdbService }],
    }).compile();

    service = module.get<GameGatewayService>(GameGatewayService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('ping', () => {
    it('returns a response using the correlationId from the request', () => {
      const request: GatewayPingRequest = { correlationId: 'corr-ping-1' };
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

    it('includes "GatewayService" in supportedServices', () => {
      expect(service.ping({}).supportedServices).toContain('GatewayService');
    });

    it('returns a bigint timestampMs', () => {
      expect(typeof service.ping({}).timestampMs).toBe('bigint');
    });
  });

  describe('healthCheck', () => {
    it('returns SERVING status', () => {
      const request: HealthCheckRequest = { service: 'GatewayService' };
      expect(service.healthCheck(request).status).toBe(HealthCheckResponse_ServingStatus.SERVING);
    });
  });

  describe('searchGames', () => {
    it('emits one RESULT frame per game followed by a single SOURCE_DONE', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME, DLC_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));

      const resultFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);
      const doneFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_SOURCE_DONE);

      expect(resultFrames).toHaveLength(2);
      expect(doneFrames).toHaveLength(1);
      expect(frames[frames.length - 1].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('emits only SOURCE_DONE when IGDB returns no results', async () => {
      igdbService.call.mockReturnValue(of([]));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'nonexistent' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('maps the IGDB id to externalId as a string', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const resultFrame = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

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
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toContain('IGDB unavailable');
    });

    it('prefixes protocol-relative cover URLs with "https:"', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.thumbnailUrl).toMatch(/^https:/);
      expect(result?.game?.thumbnailUrl).not.toMatch(/^\/\//);
    });

    it('sets baseGameExternalId from parent_game for DLC games', async () => {
      igdbService.call.mockReturnValue(of([DLC_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'dlc' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBe(String(DLC_GAME.parent_game?.id));
    });

    it('sets baseGameExternalId from version_parent for standalone expansions', async () => {
      igdbService.call.mockReturnValue(of([STANDALONE_EXPANSION]));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'standalone' }).pipe(toArray()),
      );
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBe(String(STANDALONE_EXPANSION.version_parent?.id));
    });

    it('does not set baseGameExternalId for base games', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'Hades' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.baseGameExternalId).toBeUndefined();
    });
  });

  describe('fetchGame', () => {
    it('returns RESULT status with populated game data', async () => {
      igdbService.call.mockReturnValue(of([BASE_GAME]));

      const request: FetchGameRequest = { correlationId: 'c', externalId: String(BASE_GAME.id) };
      const response = await firstValueFrom(service.fetchGame(request));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_RESULT);
      expect(response.game?.externalId).toBe(String(BASE_GAME.id));
      expect(response.correlationId).toBe('c');
    });

    it('returns ERROR status when no game is found', async () => {
      igdbService.call.mockReturnValue(of([]));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '9999' }));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_ERROR);
    });

    it('returns ERROR status when IGDBService throws', async () => {
      igdbService.call.mockReturnValue(throwError(() => new Error('API down')));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '9999' }));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(response.message).toContain('API down');
    });
  });

  describe('fetchExpansions', () => {
    it('streams RESULT frames for each expansion followed by SOURCE_DONE', async () => {
      igdbService.call.mockReturnValue(of([DLC_GAME]));

      const request: FetchExpansionsRequest = { correlationId: 'c', baseExternalId: String(BASE_GAME.id) };
      const frames = await firstValueFrom(service.fetchExpansions(request).pipe(toArray()));

      expect(frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_RESULT)).toHaveLength(1);
      expect(frames[frames.length - 1].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('emits an ERROR frame when IGDBService throws', async () => {
      igdbService.call.mockReturnValue(throwError(() => new Error('IGDB unreachable')));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '1942' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_ERROR);
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
  parent_game: { id: 1942 },
  platforms: [],
  genres: [],
  themes: [],
  involved_companies: [],
};

const STANDALONE_EXPANSION: IgdbGame = {
  id: 9002,
  name: 'Hades Standalone',
  game_type: 4,
  version_parent: { id: 1942 },
  platforms: [],
  genres: [],
  themes: [],
  involved_companies: [],
};
