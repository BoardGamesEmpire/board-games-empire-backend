import { FlowProducerNames } from '@bge/game-import';
import { GatewayRegistryService, GatewayRoutingRefusedError } from '@bge/gateway-registry';
import { createTestingModuleWithDb } from '@bge/testing';
import { getFlowProducerToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FlowProducer } from 'bullmq';
import { CoordinatorService } from './coordinator.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

describe('CoordinatorService', () => {
  let service: CoordinatorService;
  let registry: jest.Mocked<Pick<GatewayRegistryService, 'reinterview'>>;

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
            isConnected: jest.fn(),
            connectedGatewayIds: jest.fn().mockReturnValue([]),
            reportSuccess: jest.fn(),
            reportFailure: jest.fn(),
            reinterview: jest.fn().mockResolvedValue(undefined),
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
    registry = module.get(GatewayRegistryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // #715: an admin asks for an interview now. The answer's error is for the
  // api's logs; the api sends its client a translated message instead.
  describe('reinterviewGateway', () => {
    afterEach(() => jest.restoreAllMocks());

    it('interviews the DataGateway through the registry', async () => {
      await expect(service.reinterviewGateway({ gatewayId: 'gw-1' })).resolves.toEqual({ success: true });

      expect(registry.reinterview).toHaveBeenCalledWith('gw-1');
    });

    it("answers the registry's refusal as a failure, and logs it", async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      registry.reinterview.mockRejectedValue(new GatewayRoutingRefusedError('gw-1', 'disabled'));

      await expect(service.reinterviewGateway({ gatewayId: 'gw-1' })).resolves.toEqual({
        success: false,
        error: 'DataGateway gw-1 is disabled',
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('DataGateway gw-1 is disabled'));
    });

    it("answers a failed interview as a failure carrying the interview's error", async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      registry.reinterview.mockRejectedValue(new Error('Describe failed'));

      await expect(service.reinterviewGateway({ gatewayId: 'gw-1' })).resolves.toEqual({
        success: false,
        error: 'Describe failed',
      });
    });
  });
});
