import * as proto from '@board-games-empire/proto-gateway';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, of } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayController', () => {
  let controller: GameGatewayController;
  let service: jest.Mocked<
    Pick<GameGatewayService, 'ping' | 'healthCheck' | 'searchGames' | 'fetchGame' | 'fetchExpansions'>
  >;

  beforeEach(async () => {
    const mockService = {
      ping: jest.fn(),
      healthCheck: jest.fn(),
      searchGames: jest.fn(),
      fetchGame: jest.fn(),
      fetchExpansions: jest.fn(),
    } as jest.Mocked<
      Pick<GameGatewayService, 'ping' | 'healthCheck' | 'searchGames' | 'fetchGame' | 'fetchExpansions'>
    >;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GameGatewayController],
      providers: [{ provide: GameGatewayService, useValue: mockService }],
    }).compile();

    controller = module.get<GameGatewayController>(GameGatewayController);
    service = module.get(GameGatewayService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('ping', () => {
    it('delegates to GameGatewayService.ping and returns its result', () => {
      const request: proto.GatewayPingRequest = { correlationId: 'corr-1' };
      const expected: proto.GatewayPingResponse = {
        correlationId: 'corr-1',
        timestampMs: BigInt(Date.now()),
        gatewayName: 'BoardGameGeekGateway',
        gatewayVersion: '1.0.0',
        supportedServices: ['GatewayService'],
      };
      service.ping.mockReturnValue(expected);

      const result = controller.ping(request);

      expect(service.ping).toHaveBeenCalledWith(request);
      expect(result).toBe(expected);
    });

    it('forwards a request without a correlationId to the service', () => {
      const request: proto.GatewayPingRequest = {};
      const expected: proto.GatewayPingResponse = {
        correlationId: 'generated-uuid',
        timestampMs: BigInt(0),
        gatewayName: 'BoardGameGeekGateway',
        gatewayVersion: '1.0.0',
        supportedServices: ['GatewayService'],
      };
      service.ping.mockReturnValue(expected);

      controller.ping(request);

      expect(service.ping).toHaveBeenCalledWith(request);
    });
  });

  describe('check', () => {
    it('delegates to GameGatewayService.healthCheck', () => {
      const request: proto.HealthCheckRequest = { service: 'GatewayService' };
      const response: proto.HealthCheckResponse = {
        status: proto.HealthCheckResponse_ServingStatus.SERVING,
      };
      service.healthCheck.mockReturnValue(response);

      const result = controller.check(request);

      expect(service.healthCheck).toHaveBeenCalledWith(request);
      expect(result).toBe(response);
    });
  });

  describe('searchGames', () => {
    it('delegates to GameGatewayService.searchGames with the original request', async () => {
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
      service.searchGames.mockReturnValue(of(resultFrame, doneFrame));

      await firstValueFrom(controller.searchGames(request).pipe(toArray()));

      expect(service.searchGames).toHaveBeenCalledWith(request);
    });

    it('returns the stream emitted by the service', async () => {
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
      service.searchGames.mockReturnValue(of(resultFrame, doneFrame));

      const frames = await firstValueFrom(controller.searchGames(request).pipe(toArray()));

      expect(frames).toEqual([resultFrame, doneFrame]);
    });
  });

  describe('fetchGame', () => {
    it('delegates to GameGatewayService.fetchGame with the original request', async () => {
      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: '13' };
      const response: proto.FetchGameResponse = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: minimalGameData(),
      };
      service.fetchGame.mockReturnValue(of(response));

      await firstValueFrom(controller.fetchGame(request));

      expect(service.fetchGame).toHaveBeenCalledWith(request);
    });

    it('resolves to the FetchGameResponse emitted by the service', async () => {
      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: '13' };
      const response: proto.FetchGameResponse = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: minimalGameData(),
      };
      service.fetchGame.mockReturnValue(of(response));

      const result = await firstValueFrom(controller.fetchGame(request));

      expect(result).toBe(response);
    });

    it('passes through an ERROR response from the service', async () => {
      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: '999999' };
      const errorResponse: proto.FetchGameResponse = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_ERROR,
        message: 'Game not found',
      };
      service.fetchGame.mockReturnValue(of(errorResponse));

      const result = await firstValueFrom(controller.fetchGame(request));

      expect(result.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(result.message).toBe('Game not found');
    });
  });

  describe('fetchExpansions', () => {
    it('delegates to GameGatewayService.fetchExpansions with the original request', async () => {
      const request: proto.FetchExpansionsRequest = { correlationId: 'c', baseExternalId: '13' };
      const doneFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      };
      service.fetchExpansions.mockReturnValue(of(doneFrame));

      await firstValueFrom(controller.fetchExpansions(request).pipe(toArray()));

      expect(service.fetchExpansions).toHaveBeenCalledWith(request);
    });

    it('returns the stream emitted by the service', async () => {
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
      service.fetchExpansions.mockReturnValue(of(resultFrame, doneFrame));

      const frames = await firstValueFrom(controller.fetchExpansions(request).pipe(toArray()));

      expect(frames).toEqual([resultFrame, doneFrame]);
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
