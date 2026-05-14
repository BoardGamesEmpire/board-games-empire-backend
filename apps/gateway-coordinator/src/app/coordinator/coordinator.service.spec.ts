import { GatewayRegistryService } from '@bge/gateway-registry';
import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigService } from '@nestjs/config';
import { CoordinatorService } from './coordinator.service';

describe('CoordinatorService', () => {
  let service: CoordinatorService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [
        CoordinatorService,
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

    service = module.get<CoordinatorService>(CoordinatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
