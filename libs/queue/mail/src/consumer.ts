/**
 * Consumer entrypoint: `@bge/queue-mail/consumer`.
 *
 * Kept out of `src/index.ts` because the consumer sends mail through
 * nodemailer, and the api, which only queues it, must never load that (#654).
 * The worker imports from here.
 */
export * from './lib/consumer/mail-delivery.processor';
export * from './lib/consumer/mail-delivery.service';
export * from './lib/consumer/mail-queue-consumer.module';
export * from './lib/consumer/mail-transport.error';
