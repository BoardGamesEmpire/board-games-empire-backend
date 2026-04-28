import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import systemSettings from './configuration/system-settings.config';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [DatabaseModule, ConfigModule.forFeature(systemSettings)],
  controllers: [SystemSettingsController],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
