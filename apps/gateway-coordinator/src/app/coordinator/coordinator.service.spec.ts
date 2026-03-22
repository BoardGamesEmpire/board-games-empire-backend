import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigModule } from '@nestjs/config';
import { GatewayRegistryModule } from '../gateway-registry/gateway-registry.module';
import { CoordinatorService } from './coordinator.service';

describe('CoordinatorService', () => {
  let service: CoordinatorService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      imports: [ConfigModule.forRoot({ isGlobal: true }), GatewayRegistryModule],
      providers: [CoordinatorService],
    });

    service = module.get<CoordinatorService>(CoordinatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
