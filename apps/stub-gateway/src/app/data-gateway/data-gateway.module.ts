import { DATA_GATEWAY_DRIVER, DataGatewayController } from '@bge/gateway-host';
import { Module } from '@nestjs/common';
import { StubGatewayDriver } from './stub-gateway.driver';

@Module({
  controllers: [DataGatewayController],
  providers: [{ provide: DATA_GATEWAY_DRIVER, useClass: StubGatewayDriver }],
})
export class DataGatewayModule {}
