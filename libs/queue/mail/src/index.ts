/**
 * The producer side of the mail queue (#654): all the api imports. The
 * consumer side loads nodemailer and lives behind `@bge/queue-mail/consumer`.
 */
export * from './lib/constants/mail-queue.constants';
export * from './lib/interfaces/mail-delivery-job.interface';
export * from './lib/producer/mail-dispatcher.service';
export * from './lib/producer/mail-queue-producer.module';
export * from './lib/producer/mail-queue-unavailable.error';
