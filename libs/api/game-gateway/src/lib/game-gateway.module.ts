import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

@Module({
  imports: [DatabaseModule, GatewayCoordinatorClientModule],
  controllers: [GameGatewayController],
  providers: [GameGatewayService],
  exports: [GameGatewayService],
})
export class GameGatewayModule {}
