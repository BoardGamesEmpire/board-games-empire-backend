import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import securityTxtConfig from './configuration/security-txt.config';
import { SecurityTxtService } from './security-txt.service';
import { StrategyService } from './strategy.service';
import { WellKnownController } from './well-known.controller';

@Module({
  imports: [ConfigModule.forFeature(securityTxtConfig), DatabaseModule],
  controllers: [WellKnownController],
  providers: [StrategyService, SecurityTxtService],
})
export class WellKnownModule {}
