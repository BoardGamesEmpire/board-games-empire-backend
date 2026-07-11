import { GameGatewayController, GatewayServiceHost } from '@bge/gateway-host';
import { Module } from '@nestjs/common';
import { BggModule } from '../bgg/bgg.module';
import { GameGatewayService } from './game-gateway.service';

@Module({
  imports: [BggModule],
  controllers: [GameGatewayController],
  providers: [{ provide: GatewayServiceHost, useClass: GameGatewayService }],
})
export class GameGatewayModule {}
