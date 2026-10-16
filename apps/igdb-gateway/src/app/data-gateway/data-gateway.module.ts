import { DataGatewayController, GatewayServiceHost } from '@bge/gateway-host';
import { Module } from '@nestjs/common';
import { DataGatewayService } from './data-gateway.service';

@Module({
  controllers: [DataGatewayController],
  providers: [{ provide: GatewayServiceHost, useClass: DataGatewayService }],
})
export class DataGatewayModule {}
