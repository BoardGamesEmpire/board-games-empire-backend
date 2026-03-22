import { ClientGrpcProxy } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { COORDINATOR_SERVICE_TOKEN } from './constants';
import { GatewayCoordinatorClientService } from './coordinator.service';

describe('GatewayCoordinatorClientService', () => {
  let service: GatewayCoordinatorClientService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        GatewayCoordinatorClientService,
        {
          provide: COORDINATOR_SERVICE_TOKEN,
          useValue: ClientGrpcProxy,
        },
      ],
    }).compile();

    service = module.get(GatewayCoordinatorClientService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
