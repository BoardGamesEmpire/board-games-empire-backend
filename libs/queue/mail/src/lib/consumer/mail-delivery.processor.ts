import { MailFailureCode } from '@bge/mail';
import { ActorAwareWorkerHost, type JobMetaEnvelope } from '@bge/queue-actor-context';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { MAIL_QUEUE_NAME } from '../constants/mail-queue.constants';
import type { MailDeliveryJob } from '../interfaces/mail-delivery-job.interface';
import { MailDeliveryService } from './mail-delivery.service';
import { MailTransportError } from './mail-transport.error';

const MAIL_CODES: readonly string[] = Object.values(MailFailureCode);

/**
 * Consumes the mail queue in the worker (#654). `processJob` is one attempt
 * and throws so BullMQ owns retry and backoff. `onFailed` only logs.
 *
 * A job's data holds a password reset's single-use link, and an error's text
 * or stack can echo it. Every job is removed on failure, so this line is the
 * only trace: it carries the job id and the cause (a mail code, or an error's
 * class name), never the job, its data or an error's message.
 */
@Processor(MAIL_QUEUE_NAME)
export class MailDeliveryProcessor extends ActorAwareWorkerHost<MailDeliveryJob> {
  private readonly logger = new Logger(MailDeliveryProcessor.name);

  constructor(private readonly delivery: MailDeliveryService) {
    super();
  }

  protected async processJob(job: Job<MailDeliveryJob & JobMetaEnvelope>): Promise<void> {
    await this.delivery.deliver(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<MailDeliveryJob & JobMetaEnvelope>, error: Error): void {
    const attempts = job.opts.attempts ?? 1;
    const terminal = error instanceof UnrecoverableError || job.attemptsMade >= attempts;
    const cause = this.describe(error);

    if (terminal) {
      this.logger.error(`Mail job ${job.id} failed for good: ${cause}`);
      return;
    }

    this.logger.warn(`Mail job ${job.id} failed, will retry: attemptsMade=${job.attemptsMade} ${cause}`);
  }

  /**
   * A mail code is claimed only for a failure the delivery service
   * classified: a transport error, or an `UnrecoverableError` whose message is
   * a mail code. The base worker host's own `UnrecoverableError` keeps its
   * message (queue name and job id only). Any other error is named by class, without its message
   * or stack.
   */
  private describe(error: Error): string {
    if (error instanceof MailTransportError) {
      return `code=${error.code}`;
    }

    if (error instanceof UnrecoverableError) {
      return MAIL_CODES.includes(error.message) ? `code=${error.message}` : `reason=${error.message}`;
    }

    return `error=${error?.name ?? 'unknown'}`;
  }
}
