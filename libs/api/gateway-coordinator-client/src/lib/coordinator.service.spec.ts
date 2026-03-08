import { Test } from '@nestjs/testing';
import { GatewayCoordinatorClientService } from './coordinator.service';

describe('GatewayCoordinatorClientService', () => {
  let service: GatewayCoordinatorClientService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [GatewayCoordinatorClientService],
    }).compile();

    service = module.get(GatewayCoordinatorClientService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
