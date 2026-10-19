import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { LanguageLinkModule } from '@bge/language';
import { Module } from '@nestjs/common';
import { DataGatewayLanguageLinkController } from './data-gateway-language-link.controller';
import { DataGatewayController } from './data-gateway.controller';
import { DataGatewayService } from './data-gateway.service';

@Module({
  imports: [DatabaseModule, GatewayCoordinatorClientModule, LanguageLinkModule],
  controllers: [DataGatewayController, DataGatewayLanguageLinkController],
  providers: [DataGatewayService],
  exports: [DataGatewayService],
})
export class DataGatewayModule {}
