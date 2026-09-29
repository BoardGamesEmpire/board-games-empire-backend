import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { AuthType, GameGateway } from '@bge/database';
import { t } from '@bge/i18n';
import { PoliciesGuard } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createTestingModuleWithDb, paginationQuery } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

describe('GameGatewayController', () => {
  let controller: GameGatewayController;
  let coordinator: jest.Mocked<Pick<GatewayCoordinatorClientService, 'connectGateway' | 'disconnectGateway'>>;

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
    coordinator = module.get(GatewayCoordinatorClientService);
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

  describe("the coordinator's answer", () => {
    // What the coordinator reports when a Bearer gateway's credentials are
    // built: the refusal's key and args, meant for the server's logs.
    const reason = 'errors.gateway_registry.auth_type_not_implemented {"authType":"Bearer"}';

    afterEach(() => jest.restoreAllMocks());

    it('is sent as it came when the gateway connected', async () => {
      const response = await firstValueFrom(controller.connect('gw-1'));

      expect(response.connection_response).toEqual({ success: true });
    });

    it("is replaced with the generic copy when the gateway would not connect, and the coordinator's reason is logged", async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      coordinator.connectGateway.mockReturnValue(of({ success: false, error: reason }));

      const response = await firstValueFrom(controller.connect('gw-1'));

      expect(response).toEqual({
        gateway: expect.objectContaining({ id: 'gw-1' }),
        connection_response: { success: false, message: t('errors.game_gateway.connect_failed') },
        connection_attempt: true,
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(reason));
    });

    it("is replaced with the generic copy when the gateway would not disconnect, and the coordinator's reason is logged", async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      coordinator.disconnectGateway.mockReturnValue(of({ success: false, error: reason }));

      const response = await firstValueFrom(controller.disconnect('gw-1'));

      expect(response).toEqual({
        gateway: expect.objectContaining({ id: 'gw-1' }),
        disconnection_response: { success: false, message: t('errors.game_gateway.disconnect_failed') },
        disconnection_attempt: true,
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(reason));
    });

    // The proto's error is optional, so a failed answer may carry none.
    it.each([
      ['connect', 'Coordinator could not connect gateway gw-1: No additional info'],
      ['disconnect', 'Coordinator could not disconnect gateway gw-1: No additional info'],
    ] as const)('says no reason was given when a failed %s answer carries none', async (action, line) => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      coordinator.connectGateway.mockReturnValue(of({ success: false }));
      coordinator.disconnectGateway.mockReturnValue(of({ success: false }));

      await firstValueFrom<unknown>(controller[action]('gw-1'));

      expect(logged).toHaveBeenCalledWith(line);
    });
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
