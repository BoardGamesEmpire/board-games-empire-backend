import { DatabaseModule } from '@bge/database';
import { MailQueueProducerModule } from '@bge/queue-mail';
import { ServicesModule } from '@bge/services';
import { Module } from '@nestjs/common';
import { SystemSettingsController } from './system-settings.controller';
import { SystemSettingsService } from './system-settings.service';

@Module({
  imports: [DatabaseModule, MailQueueProducerModule, ServicesModule],
  controllers: [SystemSettingsController],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
