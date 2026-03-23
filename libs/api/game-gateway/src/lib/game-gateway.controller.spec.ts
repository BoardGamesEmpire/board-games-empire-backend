import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { AuthType, GameGateway } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { of } from 'rxjs';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayController', () => {
  let controller: GameGatewayController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      controllers: [GameGatewayController],
      providers: [
        {
          provide: GameGatewayService,
          useValue: {
            getAll: jest.fn().mockResolvedValue([]),
            getById: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue(makeGateway()),
            update: jest.fn().mockResolvedValue(makeGateway()),
            delete: jest.fn().mockResolvedValue(makeGateway()),
          } satisfies Partial<jest.Mocked<GameGatewayService>>,
        },
        {
          provide: GatewayCoordinatorClientService,
          useValue: {
            connectGateway: jest.fn().mockReturnValue(of({ success: true })),
            disconnectGateway: jest.fn().mockReturnValue(of({ success: true })),
          } satisfies Partial<jest.Mocked<GatewayCoordinatorClientService>>,
        },
      ],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(GameGatewayController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

function makeGateway(overrides: Partial<GameGateway> = {}): GameGateway {
  return {
    id: 'gw-1',
    name: 'Test Gateway',
    description: null,
    messageContext: null,
    iconUrl: null,
    logoUrl: null,
    websiteUrl: null,
    apiBaseUrl: null,
    apiDocumentation: null,
    apiVersion: null,
    connectionUrl: 'localhost',
    connectionPort: 50051,
    enabled: true,
    authType: AuthType.None,
    authParameters: null,
    usageCount: 0,
    lastUsed: null,
    createdById: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
