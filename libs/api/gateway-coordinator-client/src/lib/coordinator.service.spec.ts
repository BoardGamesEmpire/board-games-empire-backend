import { AuditContextModule } from '@bge/actor-context';
import { createTestingModuleWithDb } from '@bge/testing';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { ClsModule } from 'nestjs-cls';
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
