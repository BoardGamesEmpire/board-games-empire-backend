import { Test, TestingModule } from '@nestjs/testing';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';
import { GatewayRegistryService } from './gateway-registry.service';

describe('GatewayRegistryService', () => {
  let service: GatewayRegistryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GatewayRegistryService, GatewayCredentialsFactory],
    }).compile();

    service = module.get<GatewayRegistryService>(GatewayRegistryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
