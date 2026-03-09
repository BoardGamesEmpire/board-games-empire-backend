import { Test, TestingModule } from '@nestjs/testing';
import { GatewayRegistryController } from './gateway-registry.controller';
import { GatewayRegistryService } from './gateway-registry.service';

describe('GatewayRegistryController', () => {
  let controller: GatewayRegistryController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GatewayRegistryController],
      providers: [GatewayRegistryService],
    }).compile();

    controller = module.get<GatewayRegistryController>(GatewayRegistryController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
