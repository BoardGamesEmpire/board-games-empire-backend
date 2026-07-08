import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WEBHOOK_QUEUE_NAME } from '../constants/webhook-queue.constants';
import type { WebhookDeliveryJob } from '../interfaces/webhook-delivery-job.interface';
import { WebhookDeliveryService } from './webhook-delivery.service';

/**
 * Consumes the delivery queue in the worker. `process` performs one attempt and
 * throws on failure so BullMQ owns retry/backoff. `onFailed` distinguishes a
 * retryable attempt from a terminal one using the same `attemptsMade < attempts`
 * guard as the import processor, and only on exhaustion hands off to the
 * delivery service's failure bookkeeping (which trips auto-disable at the
 * threshold).
 */
@Processor(WEBHOOK_QUEUE_NAME)
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly delivery: WebhookDeliveryService) {
    super();
  }

  async process(job: Job<WebhookDeliveryJob>): Promise<void> {
    this.logger.debug(
      `Delivering ${job.data.deliveryId} (${job.data.eventType}) to subscription ${job.data.subscriptionId}`,
    );
    await this.delivery.deliver(job.data);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<WebhookDeliveryJob>, error: Error): Promise<void> {
    const { deliveryId, subscriptionId } = job.data;
    const attempts = job.opts.attempts ?? 1;

    if (attempts > 1 && job.attemptsMade < attempts) {
      this.logger.warn(
        `Delivery ${deliveryId} failed, will retry: attemptsMade=${job.attemptsMade} attempts=${attempts} error=${error.message}`,
      );
      return;
    }

    // Terminal: exhausted the attempt budget. One consecutive-failure increment
    // per delivery, which may cross the auto-disable threshold.
    await this.delivery.recordTerminalFailure(subscriptionId, error);
  }
}
