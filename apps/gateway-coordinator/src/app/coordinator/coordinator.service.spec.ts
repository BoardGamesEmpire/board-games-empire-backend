import { GatewayRegistryService } from '@bge/gateway-registry';
import { FlowProducerNames } from '@bge/game-import';
import { createTestingModuleWithDb } from '@bge/testing';
import { getFlowProducerToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { FlowProducer } from 'bullmq';
import { CoordinatorService } from './coordinator.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

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
            getServiceClient: jest.fn(),
            isConnected: jest.fn(),
            connectedGatewayIds: jest.fn().mockReturnValue([]),
            reportSuccess: jest.fn(),
            reportFailure: jest.fn(),
          } satisfies Partial<jest.Mocked<GatewayRegistryService>>,
        },
        GameImportEnqueuerService,
        {
          provide: getFlowProducerToken(FlowProducerNames.GamesImport),
          useValue: {
            add: jest.fn(),
          } satisfies Partial<jest.Mocked<FlowProducer>>,
        },
      ],
    });

    service = module.get<CoordinatorService>(CoordinatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
