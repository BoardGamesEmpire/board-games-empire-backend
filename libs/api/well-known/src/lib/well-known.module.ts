import { DatabaseModule } from '@bge/database';
import { ServicesModule } from '@bge/services';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import bgeIdentityConfig from './configuration/bge-identity.config';
import securityTxtConfig from './configuration/security-txt.config';
import { SecurityTxtService } from './security-txt.service';
import { StrategyService } from './strategy.service';
import { WellKnownController } from './well-known.controller';

@Module({
  imports: [ConfigModule.forFeature(securityTxtConfig), ConfigModule.forFeature(bgeIdentityConfig), DatabaseModule, ServicesModule],
  controllers: [WellKnownController],
  providers: [StrategyService, SecurityTxtService],
})
export class WellKnownModule {}
