import { DataGatewayController, GatewayServiceHost } from '@bge/gateway-host';
import { Module } from '@nestjs/common';
import { StubGatewayService } from './stub-gateway.service';

@Module({
  controllers: [DataGatewayController],
  providers: [{ provide: GatewayServiceHost, useClass: StubGatewayService }],
})
export class DataGatewayModule {}
