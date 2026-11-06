import { AuditContextService, type Actor } from '@bge/actor-context';
import type { MailMessage } from '@bge/mail';
import { wrapJobData } from '@bge/queue-actor-context';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  MAIL_DELIVERY_ATTEMPTS,
  MAIL_DELIVERY_BACKOFF_MS,
  MAIL_DELIVERY_JOB,
  MAIL_QUEUE_NAME,
  MAIL_TEST_ATTEMPTS,
} from '../constants/mail-queue.constants';
import type { MailDeliveryJob } from '../interfaces/mail-delivery-job.interface';
import { MailQueueUnavailableError } from './mail-queue-unavailable.error';

/**
 * Queue *producer* for outgoing mail (#654). The api never connects to an
 * SMTP server: it adds a job and the worker sends it.
 *
 * Every job is removed when it completes or fails for good, because a password
 * reset's data holds a single-use link that must not sit in Redis.
 */
@Injectable()
export class MailDispatcherService {
  constructor(
    private readonly auditContext: AuditContextService,
    @InjectQueue(MAIL_QUEUE_NAME) private readonly queue: Queue<MailDeliveryJob>,
  ) {}

  /**
   * Throws `MailQueueUnavailableError` at once while the queue's Redis
   * connection is down, and otherwise whatever `queue.add` throws; the caller
   * decides what a lost mail means.
   */
  async enqueue(recipientUserId: string, message: MailMessage): Promise<void> {
    if (!this.connectionReady()) {
      throw new MailQueueUnavailableError();
    }

    const actor = this.auditContext.getActor() ?? this.unattributedActor();
    const correlationId = this.auditContext.getCorrelationId() ?? randomUUID();

    await this.queue.add(MAIL_DELIVERY_JOB, wrapJobData({ recipientUserId, message }, { actor, correlationId }), {
      attempts: message.kind === 'test' ? MAIL_TEST_ATTEMPTS : MAIL_DELIVERY_ATTEMPTS,
      backoff: { type: 'exponential', delay: MAIL_DELIVERY_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /**
   * The queue's client keeps no command from a closed connection: it holds it
   * until Redis is back (the queue client retries forever, as BullMQ needs).
   * The connection is the shared ioredis client the app's `BullModule` root
   * passes in; connection options with no live client count as ready.
   */
  private connectionReady(): boolean {
    const connection = this.queue.opts?.connection as { status?: unknown } | undefined;

    return typeof connection?.status !== 'string' || connection.status === 'ready';
  }

  private unattributedActor(): Actor {
    return { kind: 'system', reason: 'mail:unattributed' };
  }
}
