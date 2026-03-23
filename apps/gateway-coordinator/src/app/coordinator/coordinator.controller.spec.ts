import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigModule } from '@nestjs/config';
import { GatewayRegistryModule } from '../gateway-registry/gateway-registry.module';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameSearchService } from './game-search.service';

describe('CoordinatorController', () => {
  let controller: CoordinatorController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      imports: [ConfigModule.forRoot({ isGlobal: true }), GatewayRegistryModule],
      controllers: [CoordinatorController],
      providers: [CoordinatorService, GameSearchService],
    });

    controller = module.get<CoordinatorController>(CoordinatorController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
