import * as proto from '@boardgamesempire/proto-gateway';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, of } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { GameGatewayController } from './game-gateway.controller';
import { GatewayServiceHost } from './gateway-service.host';

describe('GameGatewayController', () => {
  let controller: GameGatewayController;
  let host: jest.Mocked<GatewayServiceHost>;

  beforeEach(async () => {
    const mockHost: jest.Mocked<GatewayServiceHost> = {
      ping: jest.fn(),
      healthCheck: jest.fn(),
      searchGames: jest.fn(),
      fetchGame: jest.fn(),
      fetchExpansions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GameGatewayController],
      providers: [{ provide: GatewayServiceHost, useValue: mockHost }],
    }).compile();

    controller = module.get(GameGatewayController);
    host = module.get(GatewayServiceHost);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('ping', () => {
    it('delegates to the host and returns its result', () => {
      const request: proto.GatewayPingRequest = { correlationId: 'corr-1' };
      const expected: proto.GatewayPingResponse = {
        correlationId: 'corr-1',
        timestampMs: BigInt(0),
        gatewayName: 'TestGateway',
        gatewayVersion: '1.0.0',
        supportedServices: ['GatewayService'],
        languagePreferences: {
          acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME],
          responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME,
          passthroughRawLocale: false,
        },
      };
      host.ping.mockReturnValue(expected);

      const result = controller.ping(request);

      expect(host.ping).toHaveBeenCalledWith(request);
      expect(result).toBe(expected);
    });
  });

  describe('check', () => {
    it('delegates to host.healthCheck and returns its result', () => {
      const request: proto.HealthCheckRequest = { service: 'GatewayService' };
      const expected: proto.HealthCheckResponse = {
        status: proto.HealthCheckResponse_ServingStatus.SERVING,
      };
      host.healthCheck.mockReturnValue(expected);

      const result = controller.check(request);

      expect(host.healthCheck).toHaveBeenCalledWith(request);
      expect(result).toBe(expected);
    });
  });

  describe('searchGames', () => {
    it('delegates to the host with the original request and streams its frames', async () => {
      const request: proto.GatewaySearchRequest = { correlationId: 'c', query: 'catan' };
      const resultFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: minimalGameSearchData(),
      };
      const doneFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      };
      host.searchGames.mockReturnValue(of(resultFrame, doneFrame));

      const frames = await firstValueFrom(controller.searchGames(request).pipe(toArray()));

      expect(host.searchGames).toHaveBeenCalledWith(request);
      expect(frames).toEqual([resultFrame, doneFrame]);
    });
  });

  describe('fetchGame', () => {
    it('delegates to the host with the original request and resolves its response', async () => {
      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: '13' };
      const response: proto.FetchGameResponse = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: minimalGameData(),
      };
      host.fetchGame.mockReturnValue(of(response));

      const result = await firstValueFrom(controller.fetchGame(request));

      expect(host.fetchGame).toHaveBeenCalledWith(request);
      expect(result).toBe(response);
    });

    it('passes through an ERROR response from the host', async () => {
      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: '999999' };
      const errorResponse: proto.FetchGameResponse = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_ERROR,
        message: 'Game not found',
      };
      host.fetchGame.mockReturnValue(of(errorResponse));

      const result = await firstValueFrom(controller.fetchGame(request));

      expect(result.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(result.message).toBe('Game not found');
    });
  });

  describe('fetchExpansions', () => {
    it('delegates to the host with the original request and streams its frames', async () => {
      const request: proto.FetchExpansionsRequest = { correlationId: 'c', baseExternalId: '13' };
      const resultFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: minimalGameSearchData(),
      };
      const doneFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      };
      host.fetchExpansions.mockReturnValue(of(resultFrame, doneFrame));

      const frames = await firstValueFrom(controller.fetchExpansions(request).pipe(toArray()));

      expect(host.fetchExpansions).toHaveBeenCalledWith(request);
      expect(frames).toEqual([resultFrame, doneFrame]);
    });

    it('passes through an ERROR frame from the host', async () => {
      const request: proto.FetchExpansionsRequest = { correlationId: 'c', baseExternalId: '13' };
      const errorFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_ERROR,
        message: 'Gateway unreachable',
      };
      host.fetchExpansions.mockReturnValue(of(errorFrame));

      const frames = await firstValueFrom(controller.fetchExpansions(request).pipe(toArray()));

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toBe('Gateway unreachable');
    });
  });
});

function minimalGameSearchData(): proto.GameSearchData {
  return {
    externalId: '13',
    title: 'Catan',
    contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
    availablePlatforms: [],
    availableReleases: [],
  };
}

function minimalGameData(): proto.GameData {
  return {
    externalId: '13',
    title: 'Catan',
    contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
    designers: [],
    artists: [],
    publishers: [],
    mechanics: [],
    categories: [],
    families: [],
    platforms: [],
    releases: [],
    themes: [],
    ageRatings: [],
    metadataKeys: [],
    metadataValues: [],
    dlc: [],
  };
}
