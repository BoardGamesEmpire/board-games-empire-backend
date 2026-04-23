import * as proto from '@board-games-empire/proto-gateway';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, of } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayController', () => {
  let controller: GameGatewayController;
  let service: jest.Mocked<GameGatewayService>;

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

  describe('ping', () => {
    it('delegates to GameGatewayService.ping and returns its result', () => {
      const request: proto.GatewayPingRequest = { correlationId: 'corr-1' };
      const expected: proto.GatewayPingResponse = {
        correlationId: 'corr-1',
        timestampMs: BigInt(Date.now()),
        gatewayName: 'IgdbGateway',
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
        gatewayName: 'IgdbGateway',
        gatewayVersion: '1.0.0',
        supportedServices: ['GatewayService'],
      };
      service.ping.mockReturnValue(expected);

      controller.ping(request);

      expect(service.ping).toHaveBeenCalledWith(request);
    });
  });

  describe('check', () => {
    it('delegates to GameGatewayService.healthCheck and returns its result', () => {
      const request: proto.HealthCheckRequest = { service: 'GatewayService' };
      const expected: proto.HealthCheckResponse = {
        status: proto.HealthCheckResponse_ServingStatus.SERVING,
      };
      service.healthCheck.mockReturnValue(expected);

      const result = controller.check(request);

      expect(service.healthCheck).toHaveBeenCalledWith(request);
      expect(result).toBe(expected);
    });
  });

  describe('searchGames', () => {
    it('delegates to GameGatewayService.searchGames with the original request', async () => {
      const request: proto.GatewaySearchRequest = { correlationId: 'c', query: 'Hades' };
      const doneFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      };
      service.searchGames.mockReturnValue(of(doneFrame));

      await firstValueFrom(controller.searchGames(request).pipe(toArray()));

      expect(service.searchGames).toHaveBeenCalledWith(request);
    });

    it('streams all frames emitted by the service Observable', async () => {
      const request: proto.GatewaySearchRequest = { correlationId: 'c', query: 'Hades' };
      const resultFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: {
          availablePlatforms: [],
          availableReleases: [],
          externalId: '1942',
          title: 'Hades',
          contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
        },
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
      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: '1942' };
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
      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: '1942' };
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
      const request: proto.FetchGameRequest = { correlationId: 'c', externalId: '9999' };
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
      const request: proto.FetchExpansionsRequest = { correlationId: 'c', baseExternalId: '1942' };
      const doneFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      };
      service.fetchExpansions.mockReturnValue(of(doneFrame));

      await firstValueFrom(controller.fetchExpansions(request).pipe(toArray()));

      expect(service.fetchExpansions).toHaveBeenCalledWith(request);
    });

    it('streams all frames emitted by the service Observable', async () => {
      const request: proto.FetchExpansionsRequest = { correlationId: 'c', baseExternalId: '1942' };
      const resultFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: {
          availablePlatforms: [],
          availableReleases: [],
          externalId: '9001',
          title: 'Hades - Extra Weapons Pack',
          contentType: proto.ContentType.CONTENT_TYPE_DLC,
          baseGameExternalId: '1942',
        },
      };
      const doneFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      };
      service.fetchExpansions.mockReturnValue(of(resultFrame, doneFrame));

      const frames = await firstValueFrom(controller.fetchExpansions(request).pipe(toArray()));

      expect(frames).toEqual([resultFrame, doneFrame]);
    });

    it('passes through an ERROR frame from the service', async () => {
      const request: proto.FetchExpansionsRequest = { correlationId: 'c', baseExternalId: '1942' };
      const errorFrame: proto.GatewaySearchResult = {
        correlationId: 'c',
        status: proto.ResultStatus.RESULT_STATUS_ERROR,
        message: 'IGDB API unreachable',
      };
      service.fetchExpansions.mockReturnValue(of(errorFrame));

      const frames = await firstValueFrom(controller.fetchExpansions(request).pipe(toArray()));

      expect(frames).toHaveLength(1);
      expect(frames[0].status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
      expect(frames[0].message).toBe('IGDB API unreachable');
    });
  });
});

/**
 * Builds the minimal valid GameData required by the proto contract.
 */
function minimalGameData(): proto.GameData {
  return {
    ageRatings: [],
    artists: [],
    categories: [],
    contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
    designers: [],
    dlc: [],
    externalId: '1942',
    families: [],
    mechanics: [],
    metadataKeys: [],
    metadataValues: [],
    platforms: [],
    publishers: [],
    releases: [],
    themes: [],
    title: 'Hades',
  };
}
