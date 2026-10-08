import { GameGatewayController, GatewayServiceHost } from '@bge/gateway-host';
import { Module } from '@nestjs/common';
import { StubGatewayService } from './stub-gateway.service';

@Module({
  controllers: [GameGatewayController],
  providers: [{ provide: GatewayServiceHost, useClass: StubGatewayService }],
})
export class GameGatewayModule {}
