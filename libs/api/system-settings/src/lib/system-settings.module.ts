import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [DatabaseModule],
  controllers: [SystemSettingsController],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
