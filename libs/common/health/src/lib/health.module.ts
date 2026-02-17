import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import healthConfig from './configuration/health.config';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  imports: [ConfigModule.forFeature(healthConfig), HttpModule, TerminusModule],
  providers: [],
  exports: [],
})
export class HealthModule {}
