import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { I18nConfigModule } from '@bge/i18n';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { ServicesModule } from '@bge/services';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MAIL_QUEUE_NAME } from '../constants/mail-queue.constants';
import { MailDeliveryProcessor } from './mail-delivery.processor';
import { MailDeliveryService } from './mail-delivery.service';

/**
 * Consumer end of the mail queue (#654). Imported by the worker app only:
 * registering the queue here attaches the BullMQ worker, and the api's
 * producer module registers it for enqueue.
 *
 * `I18nConfigModule` is imported here and nowhere else in the worker. It calls
 * `I18nModule.forRoot`, and the worker's global `ClsModule` satisfies its
 * resolver. `ServicesModule` supplies `EncryptionService` for the SMTP
 * password, and `NotificationsServiceModule` writes the admin's test result.
 */
@Module({
  imports: [
    AuditContextModule,
    DatabaseModule,
    I18nConfigModule,
    NotificationsServiceModule,
    ServicesModule,
    BullModule.registerQueue({ name: MAIL_QUEUE_NAME }),
  ],
  providers: [MailDeliveryService, MailDeliveryProcessor],
  exports: [MailDeliveryService],
})
export class MailQueueConsumerModule {}
