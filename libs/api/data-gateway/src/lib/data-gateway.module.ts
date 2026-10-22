import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { VocabularySectionQueueModule } from '@bge/gateway-registry';
import { LanguageLinkModule } from '@bge/language';
import { VocabularyLinkModule } from '@bge/vocabulary';
import { Module } from '@nestjs/common';
import { DataGatewayLanguageLinkController } from './data-gateway-language-link.controller';
import {
  DataGatewayCategoryLinkController,
  DataGatewayMechanicLinkController,
  DataGatewayPlatformLinkController,
} from './data-gateway-vocabulary-link.controller';
import { DataGatewayController } from './data-gateway.controller';
import { DataGatewayService } from './data-gateway.service';

@Module({
  imports: [
    DatabaseModule,
    GatewayCoordinatorClientModule,
    LanguageLinkModule,
    VocabularyLinkModule,
    VocabularySectionQueueModule,
  ],
  controllers: [
    DataGatewayController,
    DataGatewayLanguageLinkController,
    DataGatewayPlatformLinkController,
    DataGatewayCategoryLinkController,
    DataGatewayMechanicLinkController,
  ],
  providers: [DataGatewayService],
  exports: [DataGatewayService],
})
export class DataGatewayModule {}
