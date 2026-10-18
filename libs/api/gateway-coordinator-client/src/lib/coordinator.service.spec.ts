import { AuditContextModule, SystemActorScope } from '@bge/actor-context';
import { createTestingModuleWithDb } from '@bge/testing';
import { ClientGrpcProxy, type ClientGrpc } from '@nestjs/microservices';
import { ClsModule } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';
import { COORDINATOR_SERVICE_TOKEN } from './constants';
import { GatewayCoordinatorClientService } from './coordinator.service';

describe('GatewayCoordinatorClientService', () => {
  let service: GatewayCoordinatorClientService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      imports: [AuditContextModule, ClsModule.forRoot({ global: true })],
      providers: [
        GatewayCoordinatorClientService,
        {
          provide: COORDINATOR_SERVICE_TOKEN,
          useValue: ClientGrpcProxy,
        },
      ],
    });

    service = module.get(GatewayCoordinatorClientService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});

describe('GatewayCoordinatorClientService.reinterviewGateway', () => {
  it('sends the request to the coordinator (#715)', async () => {
    const stub = { reinterviewGateway: jest.fn().mockReturnValue(of({ success: true })) };
    const client = { getService: jest.fn().mockReturnValue(stub) } as unknown as ClientGrpc;
    const service = new GatewayCoordinatorClientService(client, {} as SystemActorScope);

    service.onModuleInit();
    try {
      await expect(firstValueFrom(service.reinterviewGateway({ gatewayId: 'gw-1' }))).resolves.toEqual({
        success: true,
      });
      expect(stub.reinterviewGateway).toHaveBeenCalledWith({ gatewayId: 'gw-1' });
    } finally {
      service.onModuleDestroy();
    }
  });
});
