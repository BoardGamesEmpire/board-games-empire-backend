import { DataGatewayController, GatewayServiceHost } from '@bge/gateway-host';
import { Module } from '@nestjs/common';
import { BggModule } from '../bgg/bgg.module';
import { DataGatewayService } from './data-gateway.service';

@Module({
  imports: [BggModule],
  controllers: [DataGatewayController],
  providers: [{ provide: GatewayServiceHost, useClass: DataGatewayService }],
})
export class DataGatewayModule {}
