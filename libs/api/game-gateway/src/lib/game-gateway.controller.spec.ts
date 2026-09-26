import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { AuthType, GameGateway } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createTestingModuleWithDb, paginationQuery } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';
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
            getAll: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
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

  // The service composes the `GameGateway` scope; the envelope is where the
  // guard checks for it, under the resource type the handler passes. Built
  // inside a request with nothing composed, a `GameGateway` envelope must fail.
  // An envelope declaring `Unscoped` instead would pass here, and so would one
  // passing a type still in `PENDING_SCOPE_SWEEP` — either switches the guard
  // off for this route without a sound.
  it('getAll builds its envelope under the GameGateway scope guard', async () => {
    await expect(
      ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.getAll(paginationQuery({ limit: 20 }))),
      ),
    ).rejects.toThrow(ListScopeNotComposedError);
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
    languagesSyncedAt: null,
    createdById: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
