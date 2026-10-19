import { GatewayGameSearchService } from '@bge/gateway-game-search';
import { createTestingModuleWithDb } from '@bge/testing';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

describe('CoordinatorController', () => {
  let controller: CoordinatorController;
  let coordinatorService: jest.Mocked<Pick<CoordinatorService, 'reinterviewGateway'>>;

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
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('hands a re-interview to the coordinator service (#715)', async () => {
    await expect(controller.reinterviewGateway({ gatewayId: 'gw-1' })).resolves.toEqual({ success: true });

    expect(coordinatorService.reinterviewGateway).toHaveBeenCalledWith({ gatewayId: 'gw-1' });
  });
});
