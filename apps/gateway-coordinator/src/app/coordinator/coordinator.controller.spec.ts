import { GatewayGameSearchService } from '@bge/gateway-game-search';
import { createTestingModuleWithDb } from '@bge/testing';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

describe('CoordinatorController', () => {
  let controller: CoordinatorController;

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
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
