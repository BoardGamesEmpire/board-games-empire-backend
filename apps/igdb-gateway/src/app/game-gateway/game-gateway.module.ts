import { GameGatewayController, GatewayServiceHost } from '@bge/gateway-host';
import { Module } from '@nestjs/common';
import { GameGatewayService } from './game-gateway.service';

@Module({
  controllers: [GameGatewayController],
  providers: [{ provide: GatewayServiceHost, useClass: GameGatewayService }],
})
export class GameGatewayModule {}
