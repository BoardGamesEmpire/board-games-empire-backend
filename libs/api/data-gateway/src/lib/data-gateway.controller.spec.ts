import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { AuthType, DataGateway } from '@bge/database';
import { t } from '@bge/i18n';
import { PoliciesGuard } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createTestingModuleWithDb, paginationQuery } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom, of, throwError } from 'rxjs';
import { DataGatewayController } from './data-gateway.controller';
import { DataGatewayService } from './data-gateway.service';
import { CreateDataGatewayDto } from './dto';

describe('DataGatewayController', () => {
  let controller: DataGatewayController;
  let service: jest.Mocked<Pick<DataGatewayService, 'getById'>>;
  let coordinator: jest.Mocked<Pick<GatewayCoordinatorClientService, 'connectGateway' | 'disconnectGateway'>>;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      controllers: [DataGatewayController],
      providers: [
        {
          provide: DataGatewayService,
          useValue: {
            getAll: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
            getById: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue(makeGateway()),
            update: jest.fn().mockResolvedValue(makeGateway()),
            delete: jest.fn().mockResolvedValue(makeGateway()),
          } satisfies Partial<jest.Mocked<DataGatewayService>>,
        },
        {
          provide: GatewayCoordinatorClientService,
          useValue: {
            connectGateway: jest.fn().mockReturnValue(of({ success: true })),
            disconnectGateway: jest.fn().mockReturnValue(of({ success: true })),
          } satisfies Partial<jest.Mocked<GatewayCoordinatorClientService>>,
        },
      ],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(DataGatewayController);
    service = module.get(DataGatewayService);
    coordinator = module.get(GatewayCoordinatorClientService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // The service composes the `DataGateway` scope; the envelope is where the
  // guard checks for it, under the resource type the handler passes. Built
  // inside a request with nothing composed, a `DataGateway` envelope must fail.
  // An envelope declaring `Unscoped` instead would pass here, which switches
  // the guard off for this route without a sound.
  it('getAll builds its envelope under the DataGateway scope guard', async () => {
    await expect(
      ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.getAll(paginationQuery({ limit: 20 }))),
      ),
    ).rejects.toThrow(ListScopeNotComposedError);
  });

  // The keys name the resource as the glossary does, and as a pair, like every
  // other list and its rows: `dataGateways` for the list, `dataGateway` for one.
  describe('response keys', () => {
    it('lists the rows under dataGateways', async () => {
      const response = await firstValueFrom(controller.getAll(paginationQuery({ limit: 20 })));

      expect(Object.keys(response).sort()).toEqual(['dataGateways', 'pagination']);
    });

    it('returns one row under dataGateway', async () => {
      service.getById.mockResolvedValue(makeGateway());

      await expect(firstValueFrom(controller.getById('gw-1'))).resolves.toEqual({
        dataGateway: expect.objectContaining({ id: 'gw-1' }),
      });
    });

    it.each([
      ['create', (c: DataGatewayController) => c.create({ name: 'Test Gateway' } as CreateDataGatewayDto)],
      ['update', (c: DataGatewayController) => c.update('gw-1', { description: 'Updated' })],
      ['delete', (c: DataGatewayController) => c.delete('gw-1')],
      ['connect', (c: DataGatewayController) => c.connect('gw-1')],
      ['disconnect', (c: DataGatewayController) => c.disconnect('gw-1')],
    ] as const)('returns the row under dataGateway from %s', async (_action, call) => {
      const response = await firstValueFrom<Record<string, unknown>>(call(controller));

      expect(response['dataGateway']).toEqual(expect.objectContaining({ id: 'gw-1' }));
      expect(response).not.toHaveProperty('gateway');
    });
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

    it('is sent as it came when the gateway disconnected', async () => {
      const response = await firstValueFrom(controller.disconnect('gw-1'));

      expect(response.disconnection_response).toEqual({ success: true });
    });

    it("is replaced with the generic copy when the gateway would not connect, and the coordinator's reason is logged", async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      coordinator.connectGateway.mockReturnValue(of({ success: false, error: reason }));

      const response = await firstValueFrom(controller.connect('gw-1'));

      expect(response).toEqual({
        dataGateway: expect.objectContaining({ id: 'gw-1' }),
        connection_response: { success: false, message: t('errors.data_gateway.connect_failed') },
        connection_attempt: true,
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(reason));
    });

    it("is replaced with the generic copy when the gateway would not disconnect, and the coordinator's reason is logged", async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      coordinator.disconnectGateway.mockReturnValue(of({ success: false, error: reason }));

      const response = await firstValueFrom(controller.disconnect('gw-1'));

      expect(response).toEqual({
        dataGateway: expect.objectContaining({ id: 'gw-1' }),
        disconnection_response: { success: false, message: t('errors.data_gateway.disconnect_failed') },
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

    // No answer at all: the call itself fails, and its error is as much the
    // server's business as a failed answer's reason.
    it.each([
      ['connect', 'connection_response', 'errors.data_gateway.connect_failed'],
      ['disconnect', 'disconnection_response', 'errors.data_gateway.disconnect_failed'],
    ] as const)(
      'is the generic copy when the %s call itself fails, and the error is logged',
      async (action, field, key) => {
        const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const failure = new Error('14 UNAVAILABLE: connect ECONNREFUSED 127.0.0.1:50051');
        coordinator.connectGateway.mockReturnValue(throwError(() => failure));
        coordinator.disconnectGateway.mockReturnValue(throwError(() => failure));

        const response = await firstValueFrom<Record<string, unknown>>(controller[action]('gw-1'));

        expect(response[field]).toEqual({ success: false, message: t(key) });
        expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
      },
    );
  });
});

function makeGateway(overrides: Partial<DataGateway> = {}): DataGateway {
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
    capabilities: [],
    coveragePlatformTypes: [],
    coverageContentTypes: [],
    filterableAxes: [],
    acceptedLanguageCodeFormats: [],
    responseLanguageCodeFormat: null,
    passthroughSearchLanguage: null,
    contentFormat: null,
    gatewayVersion: null,
    disabledCapabilities: [],
    firstInterviewedAt: null,
    lastInterviewedAt: null,
    lastInterviewFailedAt: null,
    lastInterviewFailure: null,
    createdById: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
