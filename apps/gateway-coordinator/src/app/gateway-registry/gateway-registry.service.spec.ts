import { Test, TestingModule } from '@nestjs/testing';
import { GatewayRegistryService } from './gateway-registry.service';

describe('GatewayRegistryService', () => {
  let service: GatewayRegistryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GatewayRegistryService],
    }).compile();

    service = module.get<GatewayRegistryService>(GatewayRegistryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
