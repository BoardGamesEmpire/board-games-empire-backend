import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { AuthType, DataGateway, DataGatewayInterviewFailure } from '@bge/database';
import { t } from '@bge/i18n';
import { PoliciesGuard } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createTestingModuleWithDb, paginationQuery } from '@bge/testing';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom, Observable, of, throwError } from 'rxjs';
import { DataGatewayController } from './data-gateway.controller';
import { DataGatewayService } from './data-gateway.service';
import { toDataGatewayView } from './data-gateway.view';
import { CreateDataGatewayDto } from './dto';

describe('DataGatewayController', () => {
  let controller: DataGatewayController;
  let service: jest.Mocked<Pick<DataGatewayService, 'getById'>>;
  let coordinator: jest.Mocked<
    Pick<GatewayCoordinatorClientService, 'connectGateway' | 'disconnectGateway' | 'reinterviewGateway'>
  >;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      controllers: [DataGatewayController],
      providers: [
        {
          provide: DataGatewayService,
          useValue: {
            getAll: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
            getById: jest.fn().mockResolvedValue(makeGateway()),
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
            reinterviewGateway: jest.fn().mockReturnValue(of({ success: true })),
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

  // #753: no answer carries the stored credentials, only whether there are
  // any. Every answer also carries the derived interview status (#715).
  describe('the row each answer carries', () => {
    const stored = { apiKey: 'secret' };

    afterEach(() => jest.restoreAllMocks());

    beforeEach(() => {
      const row = makeGateway({ authParameters: stored });
      const disabled = makeGateway({ authParameters: stored, enabled: false });
      const mocked = service as unknown as jest.Mocked<DataGatewayService>;

      mocked.getAll.mockResolvedValue({ rows: [row], total: 1 });
      mocked.getById.mockResolvedValue(row);
      mocked.create.mockImplementation(async (dto) => (dto.enabled === false ? disabled : row));
      mocked.update.mockImplementation(async (_id, dto) => (dto.enabled === false ? disabled : row));
      mocked.delete.mockResolvedValue(row);
    });

    it.each([
      ['getAll', (c: DataGatewayController) => c.getAll(paginationQuery({ limit: 20 }))],
      ['getById', (c: DataGatewayController) => c.getById('gw-1')],
      ['create, enabled', (c: DataGatewayController) => c.create({ name: 'Test Gateway' } as CreateDataGatewayDto)],
      [
        'create, disabled',
        (c: DataGatewayController) => c.create({ name: 'Test Gateway', enabled: false } as CreateDataGatewayDto),
      ],
      ['update, enabled left alone', (c: DataGatewayController) => c.update('gw-1', { description: 'Updated' })],
      ['update, enabled', (c: DataGatewayController) => c.update('gw-1', { enabled: true })],
      ['update, disabled', (c: DataGatewayController) => c.update('gw-1', { enabled: false })],
      ['delete', (c: DataGatewayController) => c.delete('gw-1')],
      ['connect', (c: DataGatewayController) => c.connect('gw-1')],
      ['disconnect', (c: DataGatewayController) => c.disconnect('gw-1')],
    ] as const)('has no authParameters, from %s', async (_action, call) => {
      const response = await firstValueFrom<Record<string, unknown>>(
        call(controller) as Observable<Record<string, unknown>>,
      );

      const rows = (response['dataGateways'] as unknown[] | undefined) ?? [response['dataGateway']];

      expect(rows).toHaveLength(1);
      for (const row of rows) {
        expect(row).not.toHaveProperty('authParameters');
        expect(row).toEqual(
          expect.objectContaining({
            hasAuthParameters: true,
            interview: { interviewed: false, firstInterviewedAt: null, lastInterviewedAt: null, failure: null },
          }),
        );
      }
    });

    it.each([
      ['connect', 'connectGateway'],
      ['disconnect', 'disconnectGateway'],
    ] as const)('has no authParameters when the %s fails', async (action, rpc) => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      coordinator[rpc].mockReturnValue(of({ success: false, error: 'raw detail' }));

      const response = await firstValueFrom<Record<string, unknown>>(controller[action]('gw-1'));

      expect(response['dataGateway']).not.toHaveProperty('authParameters');
      expect(response['dataGateway']).toEqual(expect.objectContaining({ hasAuthParameters: true }));
    });

    // The server still reads the credentials where it uses them.
    it('still sends the stored credentials to the coordinator on connect', async () => {
      await firstValueFrom(controller.connect('gw-1'));

      expect(coordinator.connectGateway).toHaveBeenCalledWith(
        expect.objectContaining({ authParametersJson: '{"apiKey":"secret"}' }),
      );
    });
  });

  // #715: an admin asks for an interview now, and the answer waits for it.
  describe('interview', () => {
    const T1 = new Date('2026-10-01T12:00:00.000Z');
    const before = makeGateway();
    const after = makeGateway({ firstInterviewedAt: T1, lastInterviewedAt: T1 });

    afterEach(() => jest.restoreAllMocks());

    it('answers 404 for an unknown or deleted DataGateway, and asks the coordinator nothing', async () => {
      service.getById.mockRejectedValue(new NotFoundException());

      await expect(firstValueFrom(controller.interview('gw-1'))).rejects.toThrow(NotFoundException);
      expect(coordinator.reinterviewGateway).not.toHaveBeenCalled();
    });

    it('answers 409 for a disabled DataGateway, and asks the coordinator nothing', async () => {
      service.getById.mockResolvedValue(makeGateway({ enabled: false }));

      const refusal = await firstValueFrom(controller.interview('gw-1')).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toEqual(t('errors.data_gateway.disabled', { id: 'gw-1' }));
      expect(coordinator.reinterviewGateway).not.toHaveBeenCalled();
    });

    it('answers with the row read again after the interview', async () => {
      service.getById.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

      const response = await firstValueFrom(controller.interview('gw-1'));

      expect(coordinator.reinterviewGateway).toHaveBeenCalledWith({ gatewayId: 'gw-1' });
      expect(service.getById).toHaveBeenCalledTimes(2);
      expect(response).toEqual({
        dataGateway: toDataGatewayView(after),
        interview_attempt: true,
        interview_response: { success: true },
      });
    });

    it("sends generic copy for a failed interview, logs the coordinator's error, and still reads the row again", async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      service.getById.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      coordinator.reinterviewGateway.mockReturnValue(of({ success: false, error: 'raw detail' }));

      const response = await firstValueFrom(controller.interview('gw-1'));

      expect(response).toEqual({
        dataGateway: toDataGatewayView(after),
        interview_attempt: true,
        interview_response: { success: false, message: t('errors.data_gateway.interview_failed') },
      });
      expect(JSON.stringify(response)).not.toContain('raw detail');
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('raw detail'));
    });

    it('sends the same generic copy when the coordinator call itself fails', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const failure = new Error('14 UNAVAILABLE: connect ECONNREFUSED 127.0.0.1:50051');
      service.getById.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      coordinator.reinterviewGateway.mockReturnValue(throwError(() => failure));

      const response = await firstValueFrom(controller.interview('gw-1'));

      expect(response.interview_response).toEqual({
        success: false,
        message: t('errors.data_gateway.interview_failed'),
      });
      expect(response.dataGateway).toEqual(toDataGatewayView(after));
      expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
    });
  });

  // Connecting waits for a first interview, and the row records its outcome
  // (#715), so a connect answers with the row read again.
  describe('the row a connect answers with', () => {
    const T1 = new Date('2026-10-01T12:00:00.000Z');
    const interviewed = makeGateway({ firstInterviewedAt: T1, lastInterviewedAt: T1 });
    const failed = makeGateway({
      lastInterviewFailedAt: T1,
      lastInterviewFailure: DataGatewayInterviewFailure.DescribeFailed,
    });
    const connects = [
      ['create', (c: DataGatewayController) => c.create({ name: 'Test Gateway' } as CreateDataGatewayDto)],
      ['update, enabled', (c: DataGatewayController) => c.update('gw-1', { enabled: true })],
      ['connect', (c: DataGatewayController) => c.connect('gw-1')],
    ] as const;

    afterEach(() => jest.restoreAllMocks());

    it.each(connects)('is read again after the interview, from %s', async (_action, call) => {
      service.getById.mockResolvedValue(interviewed);

      const response = await firstValueFrom<Record<string, unknown>>(
        call(controller) as Observable<Record<string, unknown>>,
      );

      expect(service.getById).toHaveBeenCalledWith('gw-1');
      expect(response['dataGateway']).toEqual(toDataGatewayView(interviewed));
    });

    it.each(connects)('is read again after a failed connect, from %s', async (_action, call) => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      service.getById.mockResolvedValue(failed);
      coordinator.connectGateway.mockReturnValue(of({ success: false, error: 'raw detail' }));

      const response = await firstValueFrom<Record<string, unknown>>(
        call(controller) as Observable<Record<string, unknown>>,
      );

      expect(response['dataGateway']).toEqual(toDataGatewayView(failed));
      expect(response['connection_response']).toEqual({
        success: false,
        message: t('errors.data_gateway.connect_failed'),
      });
    });

    it('is read again when the coordinator call itself fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      service.getById.mockResolvedValue(failed);
      coordinator.connectGateway.mockReturnValue(throwError(() => new Error('14 UNAVAILABLE')));

      const response = await firstValueFrom(controller.connect('gw-1'));

      expect(response.dataGateway).toEqual(toDataGatewayView(failed));
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
