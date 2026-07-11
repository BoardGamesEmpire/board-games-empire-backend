import { AuditContextService, type Actor } from '@bge/actor-context';
import { FeedbackEvents, type FeedbackReportSubmittedEvent } from '@bge/feedback';
import { wrapJobData } from '@bge/queue-actor-context';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  FEEDBACK_DELIVERY_ATTEMPTS,
  FEEDBACK_DELIVERY_BACKOFF_MS,
  FEEDBACK_DELIVERY_JOB,
  FEEDBACK_FAILED_JOB_RETENTION,
  FEEDBACK_QUEUE_NAME,
} from '../constants/feedback-queue.constants';
import type { FeedbackDeliveryJob } from '../interfaces/feedback-delivery-job.interface';
import { FeedbackSinkRegistry } from '../sinks/feedback-sink.registry';

/**
 * Queue *producer*. Runs in the process that emits `feedback.report.submitted`
 * (the API, whose HTTP controller persists reports). On each submission it
 * resolves the sinks that accept the report's category and enqueues one delivery
 * job per sink; the worker's consumer performs the actual `submit()`.
 *
 * Fan-out is isolated per sink: a single failed enqueue (e.g. a transient Redis
 * blip) is logged and skipped so it can't strip the event from the other sinks.
 * The handler never throws into the emitter — a delivery-enqueue failure must
 * not break the request that produced the report (the report is already
 * persisted regardless).
 *
 * `sinksAccepting()` is the category-filter seam; per-household sink selection
 * (`HouseholdFeedbackSinkConfig`) will layer on there once it lands.
 */
@Injectable()
export class FeedbackDispatcherService {
  private readonly logger = new Logger(FeedbackDispatcherService.name);

  constructor(
    private readonly registry: FeedbackSinkRegistry,
    private readonly auditContext: AuditContextService,
    @InjectQueue(FEEDBACK_QUEUE_NAME) private readonly queue: Queue<FeedbackDeliveryJob>,
  ) {}

  @OnEvent(FeedbackEvents.FeedbackReportSubmitted)
  async onFeedbackReportSubmitted(event: FeedbackReportSubmittedEvent): Promise<void> {
    const sinks = this.registry.sinksAccepting(event.category);
    if (sinks.length === 0) {
      this.logger.debug(
        `No sink accepts category ${event.category}; report ${event.feedbackReportId} persisted locally only`,
      );
      return;
    }

    // Actor + correlation are lifted from the submitting request's CLS scope and
    // carried into each job so the worker attributes the delivery correctly.
    const actor = this.auditContext.getActor() ?? this.unattributedActor();
    const correlationId = this.auditContext.getCorrelationId() ?? randomUUID();

    let failures = 0;
    for (const sink of sinks) {
      try {
        await this.enqueue(event.feedbackReportId, sink.slug, actor, correlationId);
      } catch (err) {
        failures += 1;
        this.logger.error(
          `Failed to enqueue feedback delivery for report ${event.feedbackReportId} to sink '${sink.slug}': ` +
            `${err instanceof Error ? err.message : err}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    if (failures > 0) {
      this.logger.warn(
        `Feedback fan-out for report ${event.feedbackReportId}: ${failures}/${sinks.length} deliveries failed to enqueue and were dropped`,
      );
    }
  }

  private async enqueue(feedbackReportId: string, sinkSlug: string, actor: Actor, correlationId: string): Promise<void> {
    // Deterministic jobId dedups concurrent / rapid re-emits of the same
    // (report, sink) *while the job is still in the queue* — BullMQ ignores an
    // add whose jobId is still present. This is NOT at-most-once across time:
    // with removeOnComplete the id is freed after success, so a later re-emit
    // would re-deliver. On the happy path that can't happen — feedback.report.
    // submitted fires once per report (correlationKey is unique) — and the sink
    // idempotency contract covers the residual case.
    const jobId = `feedback:${feedbackReportId}:${sinkSlug}`;

    await this.queue.add(FEEDBACK_DELIVERY_JOB, wrapJobData({ feedbackReportId, sinkSlug }, { actor, correlationId }), {
      jobId,
      attempts: FEEDBACK_DELIVERY_ATTEMPTS,
      backoff: { type: 'exponential', delay: FEEDBACK_DELIVERY_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: { count: FEEDBACK_FAILED_JOB_RETENTION },
    });
  }

  private unattributedActor(): Actor {
    return { kind: 'system', reason: 'feedback:unattributed-submission' };
  }
}
