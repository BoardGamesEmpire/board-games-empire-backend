import { ActorAwareWorkerHost, type JobMetaEnvelope } from '@bge/queue-actor-context';
import { guardWorkerEvent } from '@bge/utils';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FEEDBACK_QUEUE_NAME } from '../constants/feedback-queue.constants';
import type { FeedbackDeliveryJob } from '../interfaces/feedback-delivery-job.interface';
import { FeedbackDeliveryService } from './feedback-delivery.service';

/**
 * Consumes the feedback delivery queue in the worker. Extends
 * `ActorAwareWorkerHost` so each job runs inside the CLS scope reconstructed
 * from its `__meta` envelope (actor + correlation). `processJob` performs one
 * attempt and throws on failure so BullMQ owns retry/backoff; `onFailed`
 * distinguishes a retryable attempt from a terminal one and only on exhaustion
 * hands off to the delivery service's terminal-failure bookkeeping.
 */
@Processor(FEEDBACK_QUEUE_NAME)
export class FeedbackDeliveryProcessor extends ActorAwareWorkerHost<FeedbackDeliveryJob> {
  private readonly logger = new Logger(FeedbackDeliveryProcessor.name);

  constructor(private readonly delivery: FeedbackDeliveryService) {
    super();
  }

  protected async processJob(job: Job<FeedbackDeliveryJob & JobMetaEnvelope>): Promise<void> {
    this.logger.debug(`Delivering feedback report ${job.data.feedbackReportId} to sink '${job.data.sinkSlug}'`);
    await this.delivery.deliver(job.data);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<FeedbackDeliveryJob & JobMetaEnvelope>, error: Error): Promise<void> {
    const { feedbackReportId, sinkSlug } = job.data;
    const attempts = job.opts.attempts ?? 1;

    if (attempts > 1 && job.attemptsMade < attempts) {
      this.logger.warn(
        `Feedback delivery for report ${feedbackReportId} to sink '${sinkSlug}' failed, will retry: ` +
          `attemptsMade=${job.attemptsMade} attempts=${attempts} error=${error.message}`,
      );
      return;
    }

    // Known gap (shared with the webhook processor): a job BullMQ fails via
    // stalled-exhaustion can have attemptsMade < attempts yet never run again,
    // so it skips this bookkeeping and the submission stays Pending. The robust
    // backstop is a reaper for stuck-Pending submissions (cf. #118 for import
    // jobs) rather than guessing terminality here — tracked as a follow-up.

    // Terminal: exhausted the attempt budget. Guarded because an unhandled
    // rejection out of this `failed` listener would crash the whole worker.
    await guardWorkerEvent(
      this.logger,
      `feedback delivery report ${feedbackReportId} sink ${sinkSlug} terminal-failure bookkeeping`,
      () => this.delivery.recordTerminalFailure(job.data, error),
    );
  }
}
