import { Module } from '@nestjs/common';
import { GatewayRegistryModule } from '../gateway-registry/gateway-registry.module';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';

@Module({
  imports: [GatewayRegistryModule],
  controllers: [CoordinatorController],
  providers: [CoordinatorService],
})
export class CoordinatorModule {}
