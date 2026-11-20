import { GatewayGameSearchService } from '@bge/gateway-game-search';
import { createTestingModuleWithDb } from '@bge/testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { lastValueFrom, of } from 'rxjs';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

describe('CoordinatorController', () => {
  let controller: CoordinatorController;
  let coordinatorService: jest.Mocked<Pick<CoordinatorService, 'reinterviewGateway'>>;
  let gameSearchService: jest.Mocked<Pick<GatewayGameSearchService, 'findUpstreamAccount'>>;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      controllers: [CoordinatorController],
      providers: [
        {
          provide: CoordinatorService,
          useValue: {
            ping: jest.fn(),
            healthCheck: jest.fn(),
            connectGateway: jest.fn(),
            disconnectGateway: jest.fn(),
            reinterviewGateway: jest.fn().mockResolvedValue({ success: true }),
          } satisfies Partial<jest.Mocked<CoordinatorService>>,
        },
        {
          provide: GatewayGameSearchService,
          useValue: {
            searchGames: jest.fn(),
            fetchGame: jest.fn(),
            fetchExpansions: jest.fn(),
            findUpstreamAccount: jest.fn(),
          } satisfies Partial<jest.Mocked<GatewayGameSearchService>>,
        },
        {
          provide: GameImportEnqueuerService,
          useValue: {
            enqueue: jest.fn(),
          } satisfies Partial<jest.Mocked<GameImportEnqueuerService>>,
        },
      ],
    });

    controller = module.get<CoordinatorController>(CoordinatorController);
    coordinatorService = module.get(CoordinatorService);
    gameSearchService = module.get(GatewayGameSearchService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('hands a re-interview to the coordinator service (#715)', async () => {
    await expect(controller.reinterviewGateway({ gatewayId: 'gw-1' })).resolves.toEqual({ success: true });

    expect(coordinatorService.reinterviewGateway).toHaveBeenCalledWith({ gatewayId: 'gw-1' });
  });

  it('hands an upstream account lookup to the DataGateway search service, and relays its answer (#1226)', async () => {
    const request: proto.CoordinatorFindUpstreamAccountRequest = {
      correlationId: 'c',
      gatewayId: 'bgg',
      username: 'Ada',
    };
    const answer: proto.CoordinatorFindUpstreamAccountResponse = {
      correlationId: 'c',
      gatewayId: 'bgg',
      status: proto.ResultStatus.RESULT_STATUS_RESULT,
      account: { externalId: 'Ada', displayName: 'Ada' },
    };
    gameSearchService.findUpstreamAccount.mockReturnValue(of(answer));

    await expect(lastValueFrom(controller.findUpstreamAccount(request))).resolves.toEqual(answer);
    expect(gameSearchService.findUpstreamAccount).toHaveBeenCalledWith(request);
  });
});
