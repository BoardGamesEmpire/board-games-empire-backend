import {
  FetchGameRequest,
  GatewayPingRequest,
  GatewaySearchRequest,
  HealthCheckRequest,
  HealthCheckResponse_ServingStatus,
  ResultStatus,
} from '@board-games-empire/proto-gateway';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { BggService } from '../bgg/bgg.service';
import { BggLinkType, BggNameType, BggThingType, MAX_THINGS_PER_BATCH } from '../constants';
import type { BggSearchItem, BggThing } from '../types';
import { GameGatewayService } from './game-gateway.service';

// ---------------------------------------------------------------------------
// Mock BggService to isolate GameGatewayService from real API calls. Only the
// `call` method is exercised by the gateway.
// ---------------------------------------------------------------------------
function buildMockBggService(): jest.Mocked<Pick<BggService, 'call'>> {
  return { call: jest.fn() };
}

describe('GameGatewayService', () => {
  let service: GameGatewayService;
  let bggService: jest.Mocked<Pick<BggService, 'call'>>;

  beforeEach(async () => {
    bggService = buildMockBggService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [GameGatewayService, { provide: BggService, useValue: bggService }],
    }).compile();

    service = module.get<GameGatewayService>(GameGatewayService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('ping', () => {
    it('returns a response using the correlationId from the request', () => {
      const request: GatewayPingRequest = { correlationId: 'corr-ping-1' };

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
    it('emits one RESULT frame per item followed by a single SOURCE_DONE', async () => {
      bggService.call.mockReturnValue(of([CATAN_SEARCH, GLOOMHAVEN_SEARCH]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'catan' }).pipe(toArray()));

      const resultFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);
      const doneFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_SOURCE_DONE);

      expect(resultFrames).toHaveLength(2);
      expect(doneFrames).toHaveLength(1);
      expect(frames[frames.length - 1].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('emits only SOURCE_DONE when BGG returns no results', async () => {
      bggService.call.mockReturnValue(of([]));

      const frames = await firstValueFrom(
        service.searchGames({ correlationId: 'c', query: 'nonexistent' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('maps the BGG id to externalId as a string', async () => {
      bggService.call.mockReturnValue(of([CATAN_SEARCH]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'catan' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.externalId).toBe(String(CATAN_SEARCH.id));
    });

    it('maps the BGG name to GameSearchData.title', async () => {
      bggService.call.mockReturnValue(of([CATAN_SEARCH]));

      const frames = await firstValueFrom(service.searchGames({ correlationId: 'c', query: 'catan' }).pipe(toArray()));
      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(result?.game?.title).toBe('Catan');
    });

    it('propagates the correlationId in every emitted frame', async () => {
      bggService.call.mockReturnValue(of([CATAN_SEARCH]));

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
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toContain('BGG unavailable');
    });

    it('issues exactly one bggService.call for a search', async () => {
      bggService.call.mockReturnValue(of([]));
      const request: GatewaySearchRequest = { correlationId: 'c', query: 'catan', limit: 5 };

      await firstValueFrom(service.searchGames(request).pipe(toArray()));

      expect(bggService.call).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchGame', () => {
    it('returns RESULT status with populated game data', async () => {
      bggService.call.mockReturnValue(of(CATAN_THING));

      const request: FetchGameRequest = { correlationId: 'c', externalId: String(CATAN_THING.id) };
      const response = await firstValueFrom(service.fetchGame(request));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_RESULT);
      expect(response.game?.externalId).toBe(String(CATAN_THING.id));
      expect(response.game?.title).toBe('Catan');
      expect(response.correlationId).toBe('c');
    });

    it('returns ERROR status when no thing is found', async () => {
      bggService.call.mockReturnValue(of(undefined));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '999999' }));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(response.message).toContain('999999');
    });

    it('returns ERROR status when BggService throws', async () => {
      bggService.call.mockReturnValue(throwError(() => new Error('API down')));

      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: '174430' }));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(response.message).toContain('API down');
    });

    it('returns ERROR with a parse-error message when externalId is malformed', async () => {
      const response = await firstValueFrom(service.fetchGame({ correlationId: 'c', externalId: 'not-a-number' }));

      expect(response.status).toBe(ResultStatus.RESULT_STATUS_ERROR);
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

    it('streams RESULT frames for each expansion across all batches followed by SOURCE_DONE', async () => {
      bggService.call
        .mockReturnValueOnce(of(BASE_WITH_TWO_EXPANSIONS))
        .mockReturnValueOnce(of([SEAFARERS_EXPANSION_THING, CITIES_EXPANSION_THING]));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: String(CATAN_THING.id) }).pipe(toArray()),
      );

      const resultFrames = frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

      expect(resultFrames).toHaveLength(2);
      expect(frames[frames.length - 1].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('maps each expansion thing to GameSearchData with the base externalId', async () => {
      bggService.call
        .mockReturnValueOnce(of(BASE_WITH_TWO_EXPANSIONS))
        .mockReturnValueOnce(of([SEAFARERS_EXPANSION_THING]));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: String(CATAN_THING.id) }).pipe(toArray()),
      );

      const result = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_RESULT);

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
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
      expect(bggService.call).toHaveBeenCalledTimes(1);
    });

    it('emits only SOURCE_DONE when the base game has no outbound expansion links, without a batch lookup', async () => {
      bggService.call.mockReturnValueOnce(of(BASE_WITH_NO_EXPANSIONS));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_SOURCE_DONE);
      expect(bggService.call).toHaveBeenCalledTimes(1);
    });

    it('emits ERROR when the base lookup fails', async () => {
      bggService.call.mockReturnValueOnce(throwError(() => new Error('BGG unreachable')));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toContain('BGG unreachable');
    });

    it('emits ERROR when baseExternalId is malformed and never calls BggService', async () => {
      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: 'not-a-number' }).pipe(toArray()),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(ResultStatus.RESULT_STATUS_ERROR);
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
      };
      const batchOne: BggThing[] = expansionIds.slice(0, MAX_THINGS_PER_BATCH).map((id) => ({
        id,
        type: BggThingType.BoardGameExpansion,
        names: [{ type: BggNameType.Primary, value: `Exp ${id}` }],
      }));
      const batchTwo: BggThing[] = expansionIds.slice(MAX_THINGS_PER_BATCH).map((id) => ({
        id,
        type: BggThingType.BoardGameExpansion,
        names: [{ type: BggNameType.Primary, value: `Exp ${id}` }],
      }));

      bggService.call.mockReturnValueOnce(of(base)).mockReturnValueOnce(of(batchOne)).mockReturnValueOnce(of(batchTwo));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()),
      );

      // 1 base + 2 batches = 3 calls. This is the property that proves
      // each batch is its own retry boundary — they're separate call()
      // invocations, not bundled into one promise chain.
      expect(bggService.call).toHaveBeenCalledTimes(3);
      expect(frames.filter((f) => f.status === ResultStatus.RESULT_STATUS_RESULT)).toHaveLength(expansionIds.length);
    });

    it('emits ERROR when a single batch fails — partial-success is not modeled', async () => {
      const base: BggThing = {
        id: 13,
        type: BggThingType.BoardGame,
        names: [{ type: BggNameType.Primary, value: 'Catan' }],
        links: [{ type: BggLinkType.BoardGameExpansion, id: 100, value: 'Expansion A' }],
      };
      bggService.call.mockReturnValueOnce(of(base)).mockReturnValueOnce(throwError(() => new Error('Batch 1 failed')));

      const frames = await firstValueFrom(
        service.fetchExpansions({ correlationId: 'c', baseExternalId: '13' }).pipe(toArray()),
      );

      const errorFrame = frames.find((f) => f.status === ResultStatus.RESULT_STATUS_ERROR);
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
};

const CITIES_EXPANSION_THING: BggThing = {
  id: 926,
  type: BggThingType.BoardGameExpansion,
  names: [{ type: BggNameType.Primary, value: 'Catan: Cities & Knights' }],
  yearpublished: 1998,
  links: [{ type: BggLinkType.BoardGameExpansion, id: 13, value: 'Catan', inbound: true }],
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
