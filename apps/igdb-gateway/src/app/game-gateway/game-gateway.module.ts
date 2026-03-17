import { Module } from '@nestjs/common';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

@Module({
  controllers: [GameGatewayController],
  providers: [GameGatewayService],
})
export class GameGatewayModule {}
