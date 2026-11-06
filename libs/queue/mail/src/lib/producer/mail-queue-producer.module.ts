import { AuditContextModule } from '@bge/actor-context';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MAIL_QUEUE_NAME } from '../constants/mail-queue.constants';
import { MailDispatcherService } from './mail-dispatcher.service';

/**
 * Producer end of the mail queue (#654): registers the queue for enqueue and
 * exports `MailDispatcherService`. Import it in the process that has mail to
 * send (the api). The worker's consumer module registers the same queue.
 */
@Module({
  imports: [AuditContextModule, BullModule.registerQueue({ name: MAIL_QUEUE_NAME })],
  providers: [MailDispatcherService],
  exports: [MailDispatcherService],
})
export class MailQueueProducerModule {}
