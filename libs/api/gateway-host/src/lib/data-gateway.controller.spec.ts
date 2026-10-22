import * as proto from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { firstValueFrom, Observable, of } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { DataGatewayController } from './data-gateway.controller';
import { GatewayServiceHost } from './gateway-service.host';

describe('DataGatewayController', () => {
  let controller: DataGatewayController;
  let host: jest.Mocked<GatewayServiceHost>;

  beforeEach(async () => {
    const mockHost: jest.Mocked<GatewayServiceHost> = {
      ping: jest.fn(),
      healthCheck: jest.fn(),
      describe: jest.fn(),
      searchGames: jest.fn(),
      fetchGame: jest.fn(),
      fetchExpansions: jest.fn(),
      listLanguages: jest.fn(),
      listPlatforms: jest.fn(),
      listCategories: jest.fn(),
      listMechanics: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DataGatewayController],
      providers: [{ provide: GatewayServiceHost, useValue: mockHost }],
    }).compile();

    controller = module.get(DataGatewayController);
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
      };
      host.ping.mockReturnValue(expected);

      const result = controller.ping(request);

      expect(host.ping).toHaveBeenCalledWith(request);
      expect(result).toBe(expected);
    });
  });

  describe('describe', () => {
    it('delegates to the host and returns its result', () => {
      const request: proto.DescribeRequest = { correlationId: 'corr-1' };
      const expected: proto.DescribeResponse = {
        correlationId: 'corr-1',
        capabilities: [proto.Capability.CAPABILITY_FETCH],
        coverage: {
          platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP],
          contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME],
        },
        filterableAxes: [],
        languageCodeFormats: {
          acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME],
          responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME,
          passthroughSearchLanguage: false,
        },
        contentFormat: proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT,
      };
      host.describe.mockReturnValue(expected);

      const result = controller.describe(request);

      expect(host.describe).toHaveBeenCalledWith(request);
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
  describe('the list calls (#718)', () => {
    it('passes ListPlatforms, ListCategories and ListMechanics to the host', async () => {
      const platforms: proto.ListPlatformsResponse = {
        correlationId: 'p',
        platforms: [{ externalId: '6', name: 'PC', platformType: proto.PlatformType.PLATFORM_TYPE_PC }],
      };
      const categories: proto.ListCategoriesResponse = {
        correlationId: 'c',
        categories: [{ externalId: '15', name: 'Strategy' }],
      };
      const mechanics: proto.ListMechanicsResponse = {
        correlationId: 'm',
        mechanics: [{ externalId: '2082', name: 'Worker Placement' }],
      };
      host.listPlatforms.mockReturnValue(of(platforms));
      host.listCategories.mockReturnValue(of(categories));
      host.listMechanics.mockReturnValue(of(mechanics));

      await expect(firstValueFrom(controller.listPlatforms({ correlationId: 'p' }))).resolves.toBe(platforms);
      await expect(firstValueFrom(controller.listCategories({ correlationId: 'c' }))).resolves.toBe(categories);
      await expect(firstValueFrom(controller.listMechanics({ correlationId: 'm' }))).resolves.toBe(mechanics);
      expect(host.listPlatforms).toHaveBeenCalledWith({ correlationId: 'p' });
      expect(host.listCategories).toHaveBeenCalledWith({ correlationId: 'c' });
      expect(host.listMechanics).toHaveBeenCalledWith({ correlationId: 'm' });
    });

    // A DataGateway declares only the lists it serves, so one that serves
    // none needs no code for them (#711, #718).
    it('answers UNIMPLEMENTED for a list the host does not override (#718)', async () => {
      const bare = new DataGatewayController(new HostWithoutLists());

      const refusal = await firstValueFrom(bare.listMechanics({ correlationId: 'm' })).catch((err: unknown) => err);

      expect(refusal).toBeInstanceOf(RpcException);
      expect((refusal as RpcException).getError()).toMatchObject({ code: status.UNIMPLEMENTED });
      await expect(firstValueFrom(bare.listPlatforms({}))).rejects.toBeInstanceOf(RpcException);
      await expect(firstValueFrom(bare.listCategories({}))).rejects.toBeInstanceOf(RpcException);
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

/** A host that serves none of the list calls, as most DataGateways serve some of them. */
class HostWithoutLists extends GatewayServiceHost {
  ping = jest.fn();
  healthCheck = jest.fn();
  describe = jest.fn();
  searchGames = jest.fn(() => new Observable<proto.GatewaySearchResult>());
  fetchGame = jest.fn(() => new Observable<proto.FetchGameResponse>());
  fetchExpansions = jest.fn(() => new Observable<proto.GatewaySearchResult>());
  listLanguages = jest.fn();
}
