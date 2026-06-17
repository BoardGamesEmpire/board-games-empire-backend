import { DatabaseService, WebhookSubscriptionStatus, isPrismaDependentRecordNotFoundError } from '@bge/database';
import { SecureHttpService } from '@bge/secure-http';
import { EncryptionService } from '@bge/services';
import { WEBHOOK_DISABLED_EVENT, WebhookSigner, type WebhookDisabledEvent } from '@bge/webhooks';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import {
  WEBHOOK_DELIVERY_HEADERS,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_FAILURE_THRESHOLD,
} from '../constants/webhook-queue.constants';
import type { WebhookDeliveryJob } from '../interfaces/webhook-delivery-job.interface';

/** Thrown to mark a delivery attempt as failed so BullMQ retries it. */
export class WebhookDeliveryFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WebhookDeliveryFailedError';
  }
}

/**
 * Performs a single delivery attempt and owns the success/failure bookkeeping —
 * the queue *consumer's* work. No internal retry: BullMQ owns the retry/backoff
 * budget; this throws on any non-2xx or transport error so the queue counts the
 * attempt and eventually surfaces a terminal failure to the processor.
 *
 * Auto-disable mirrors the gateway-registry precedent exactly: a conditional
 * `updateMany(... status: Active -> Failed)` whose `count === 0` guard means
 * only the writer that actually flipped the row emits `webhook.disabled`, so
 * concurrent terminal failures crossing the threshold notify once.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly http: SecureHttpService,
    private readonly signer: WebhookSigner,
    private readonly encryption: EncryptionService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Delivers one job. Resolves on 2xx (counters reset); throws
   * WebhookDeliveryFailedError otherwise so BullMQ records the failed attempt.
   * Silently drops if the subscription is gone or no longer Active — that is a
   * normal mid-flight disable/delete, not a delivery failure.
   */
  async deliver(job: WebhookDeliveryJob): Promise<void> {
    const subscription = await this.db.webhookSubscription.findFirst({
      where: { id: job.subscriptionId, deletedAt: null },
      select: { id: true, url: true, secret: true, status: true },
    });

    if (!subscription) {
      return this.logger.debug(`Skipping delivery ${job.deliveryId}: subscription ${job.subscriptionId} not found`);
    }

    if (subscription.status !== WebhookSubscriptionStatus.Active) {
      return this.logger.debug(`Skipping delivery ${job.deliveryId}: subscription ${job.subscriptionId} is not active`);
    }

    // The secret is stored encrypted at rest; decrypt to its plaintext, then
    // sign the exact bytes that go on the wire — stringify here, send the string.
    const body = JSON.stringify(job.payload);
    const secret = this.encryption.decrypt(subscription.secret);
    const { timestamp, signature } = this.signer.sign(secret, body);

    const response = await this.http.request(subscription.url, {
      method: 'POST',
      responseType: 'text',
      timeoutMs: WEBHOOK_DELIVERY_TIMEOUT_MS,
      body,
      headers: {
        'Content-Type': 'application/json',
        [WEBHOOK_DELIVERY_HEADERS.signature]: signature,
        [WEBHOOK_DELIVERY_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_DELIVERY_HEADERS.event]: job.eventType,
        [WEBHOOK_DELIVERY_HEADERS.deliveryId]: job.deliveryId,
      },
    });

    if (response.status < Http.Ok || response.status >= Http.MultipleChoices) {
      throw new WebhookDeliveryFailedError(
        `Delivery ${job.deliveryId} to subscription ${job.subscriptionId} returned ${response.status}`,
        response.status,
      );
    }

    return this.onSuccess(job.subscriptionId);
  }

  /**
   * Resets failure tracking after a successful delivery.
   */
  private async onSuccess(subscriptionId: string): Promise<void> {
    // updateMany: a subscription deleted between deliver()'s lookup and this
    // bookkeeping write becomes a 0-row no-op, not a P2025 that fails the job.
    await this.db.webhookSubscription.updateMany({
      where: { id: subscriptionId, deletedAt: null },
      data: { consecutiveFailures: 0, lastDeliveryAt: new Date() },
    });
  }

  /**
   * Called by the processor only when a job has exhausted its BullMQ attempts.
   * Increments the consecutive-failure counter and, on crossing the threshold,
   * trips the race-safe auto-disable.
   */
  async recordTerminalFailure(subscriptionId: string, lastError: string): Promise<void> {
    let updated: { consecutiveFailures: number; createdById: string };
    try {
      updated = await this.db.webhookSubscription.update({
        where: { id: subscriptionId },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true, createdById: true },
      });
    } catch (error) {
      // Deleted mid-retry: nothing left to track or disable, and letting P2025
      // escape would crash the worker's `failed` handler.
      if (isPrismaDependentRecordNotFoundError(error)) {
        return this.logger.debug(`Subscription ${subscriptionId} gone; skipping terminal-failure bookkeeping`);
      }

      throw error;
    }

    this.logger.warn(
      `Delivery to subscription ${subscriptionId} failed (consecutive failures: ${updated.consecutiveFailures}): ${lastError}`,
    );

    if (updated.consecutiveFailures >= WEBHOOK_FAILURE_THRESHOLD) {
      await this.autoDisable(subscriptionId, updated.createdById, updated.consecutiveFailures, lastError);
    }
  }

  private async autoDisable(
    subscriptionId: string,
    createdById: string,
    consecutiveFailures: number,
    lastError: string,
  ): Promise<void> {
    const disabledAt = new Date();

    // Race-safe transition: only an Active -> Failed flip counts. A concurrent
    // terminal failure that also crossed the threshold sees count === 0 and
    // stays quiet, so exactly one disabled notification is emitted.
    const result = await this.db.webhookSubscription.updateMany({
      where: { id: subscriptionId, status: WebhookSubscriptionStatus.Active },
      data: { status: WebhookSubscriptionStatus.Failed, disabledAt },
    });

    if (result.count === 0) {
      return;
    }

    this.logger.error(
      `Auto-disabling subscription ${subscriptionId} after ${consecutiveFailures} consecutive failures`,
    );

    this.emitter.emit(WEBHOOK_DISABLED_EVENT, {
      subscriptionId,
      createdById,
      status: 'Failed',
      consecutiveFailures,
      lastError,
      disabledAt,
    } satisfies WebhookDisabledEvent);
  }
}
