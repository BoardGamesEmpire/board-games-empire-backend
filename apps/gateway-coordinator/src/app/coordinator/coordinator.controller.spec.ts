import { GatewayRegistryService } from '@bge/gateway-registry';
import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigService } from '@nestjs/config';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameSearchService } from './game-search.service';

describe('CoordinatorController', () => {
  let controller: CoordinatorController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      controllers: [CoordinatorController],
      providers: [
        CoordinatorService,
        GameSearchService,
        ConfigService,
        {
          provide: GatewayRegistryService,
          useValue: {
            connect: jest.fn(),
            disconnect: jest.fn(),
            get: jest.fn(),
            getServiceClient: jest.fn(),
            isConnected: jest.fn(),
            connectedGatewayIds: jest.fn().mockReturnValue([]),
            reportSuccess: jest.fn(),
            reportFailure: jest.fn(),
          } satisfies Partial<jest.Mocked<GatewayRegistryService>>,
        },
      ],
    });

    controller = module.get<CoordinatorController>(CoordinatorController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
