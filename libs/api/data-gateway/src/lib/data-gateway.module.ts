import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { DataGatewayController } from './data-gateway.controller';
import { DataGatewayService } from './data-gateway.service';

@Module({
  imports: [DatabaseModule, GatewayCoordinatorClientModule],
  controllers: [DataGatewayController],
  providers: [DataGatewayService],
  exports: [DataGatewayService],
})
export class DataGatewayModule {}
