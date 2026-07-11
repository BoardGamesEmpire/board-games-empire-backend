import { DatabaseService, FeedbackSubmissionStatus, Prisma } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { FEEDBACK_LAST_ERROR_MAX_LENGTH } from '../constants/feedback-queue.constants';
import { FeedbackSinkError } from '../contract/errors';
import type { SinkSubmissionResult } from '../contract/feedback-sink';
import type { FeedbackDeliveryJob } from '../interfaces/feedback-delivery-job.interface';
import { FeedbackSinkRegistry } from '../sinks/feedback-sink.registry';

/**
 * Performs a single delivery attempt and owns the `FeedbackSubmission`
 * bookkeeping — the queue *consumer's* work. No internal retry: BullMQ owns the
 * retry/backoff budget; `deliver()` throws on any sink failure so the queue
 * counts the attempt and eventually surfaces a terminal failure to the processor.
 *
 * One `FeedbackSubmission` row per (report, sink), created on first attempt and
 * updated across retries (`attempts`, `lastError`). Failures are isolated at the
 * queue level — one sink failing never blocks another, since each (report, sink)
 * pair is an independent job.
 */
@Injectable()
export class FeedbackDeliveryService {
  private readonly logger = new Logger(FeedbackDeliveryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: FeedbackSinkRegistry,
  ) {}

  /**
   * Delivers one (report, sink) job. Resolves on success (submission marked
   * `Submitted`); throws on sink failure so BullMQ records the failed attempt.
   * Silently drops if the report was purged mid-flight — that is a normal
   * retention/GDPR delete, not a delivery failure.
   */
  async deliver(job: FeedbackDeliveryJob): Promise<void> {
    const report = await this.db.feedbackReport.findUnique({ where: { id: job.feedbackReportId } });
    if (!report) {
      return this.logger.debug(
        `Skipping delivery: feedback report ${job.feedbackReportId} not found (purged before delivery)`,
      );
    }

    // Create/find the submission row BEFORE resolving the sink, so a misrouted
    // job (unknown slug — e.g. producer/consumer registry drift during a rolling
    // deploy) leaves a Failed audit row instead of vanishing into the logs.
    const submission = await this.ensureSubmission(job.feedbackReportId, job.sinkSlug);

    let result: SinkSubmissionResult;
    try {
      const sink = this.registry.resolve(job.sinkSlug);
      result = await sink.submit(report, { submissionId: submission.id });
    } catch (err) {
      await this.recordAttemptFailure(submission.id, err);
      throw err;
    }

    // Success bookkeeping runs OUTSIDE the try on purpose: a transient failure
    // writing the Submitted row must not be recorded as a *delivery* failure
    // (the external side-effect already happened). If this write itself throws,
    // BullMQ retries the whole job; re-delivery is bounded by the sink
    // idempotency contract (`submit` MUST be safe to call again) — the same
    // at-least-once guarantee the webhook queue relies on.
    await this.recordSuccess(submission.id, result);
  }

  /**
   * Called by the processor only when a job has exhausted its BullMQ attempts.
   * Flips the submission to `Failed`. Uses a conditional `updateMany` so a report
   * purged (cascade-deleting its submissions) or a concurrently-resolved row is a
   * no-op, not a P2025 that would crash the worker's `failed` handler.
   */
  async recordTerminalFailure(job: FeedbackDeliveryJob, error: Error): Promise<void> {
    const result = await this.db.feedbackSubmission.updateMany({
      where: {
        feedbackReportId: job.feedbackReportId,
        sinkSlug: job.sinkSlug,
        status: FeedbackSubmissionStatus.Pending,
      },
      data: { status: FeedbackSubmissionStatus.Failed, lastError: this.describeError(error) },
    });

    if (result.count === 0) {
      return;
    }

    this.logger.error(
      `Feedback delivery to sink '${job.sinkSlug}' for report ${job.feedbackReportId} failed terminally: ${error.message}`,
    );

    // deferred: auto-disable a repeatedly-failing sink. That needs a per-sink
    // config row (HouseholdFeedbackSinkConfig — deferred to #59) to hold the
    // consecutive-failure counter and a disabled flag, plus the race-safe
    // `updateMany(...Active -> Disabled) count===0` guard used by the webhook
    // queue. The bundled local sink is always-on and cannot be disabled, so
    // there is nothing to trip today. See the auto-disable follow-up issue.
  }

  private async ensureSubmission(feedbackReportId: string, sinkSlug: string): Promise<{ id: string }> {
    // Upsert on the (feedbackReportId, sinkSlug) unique key: idempotent across
    // retries and race-free even if the same pair were somehow enqueued twice —
    // the DB constraint, not BullMQ serialization, is the backstop. `update: {}`
    // leaves an existing row (and its attempt counters) untouched.
    //
    // Known gap (dormant): if a pair is re-delivered *after* reaching a terminal
    // state (possible across time — removeOnComplete frees the jobId, see the
    // dispatcher) and the re-delivery then fails, `recordTerminalFailure` won't
    // flip the row (it only touches `Pending`), so `lastError`/`attempts` update
    // while the status stays `Submitted`/`Failed`. It cannot happen today: the
    // only sink is the local one, which never fails. Deliberately NOT re-armed to
    // `Pending` on every attempt — that would downgrade a genuinely-`Submitted`
    // row (external artifact already created) and, if the re-delivery then stalls
    // (see the processor's stalled-exhaustion gap), strand it as `Pending`. The
    // correct fix arrives with fallible external sinks (#59): decide per-attempt
    // authority there rather than blindly resetting status here.
    return this.db.feedbackSubmission.upsert({
      where: { feedbackReportId_sinkSlug: { feedbackReportId, sinkSlug } },
      create: { feedbackReportId, sinkSlug, status: FeedbackSubmissionStatus.Pending },
      update: {},
      select: { id: true },
    });
  }

  private async recordSuccess(submissionId: string, result: SinkSubmissionResult): Promise<void> {
    await this.db.feedbackSubmission.updateMany({
      where: { id: submissionId },
      data: {
        status: FeedbackSubmissionStatus.Submitted,
        externalId: result.externalId ?? null,
        externalUrl: result.externalUrl ?? null,
        metadata: result.metadata ?? Prisma.DbNull,
        submittedAt: new Date(),
        lastError: null,
        attempts: { increment: 1 },
      },
    });
  }

  private async recordAttemptFailure(submissionId: string, error: unknown): Promise<void> {
    await this.db.feedbackSubmission.updateMany({
      where: { id: submissionId },
      data: { attempts: { increment: 1 }, lastError: this.describeError(error) },
    });
  }

  /**
   * A DB-safe rendering of a delivery error. Our own {@link FeedbackSinkError}s
   * carry a stable code + a message we author, so those are safe to persist.
   * Arbitrary sink errors (external HTTP clients, etc.) routinely embed the
   * target URL / tokens / IPs in `message`, and `lastError` is an admin-facing
   * column — so for anything else we persist only the class name and keep the
   * full detail in the operator-scoped logs.
   *
   * @todo Adopt a per-sink error classifier (cf. the webhook `classifyDeliveryError`)
   *   when the first external sink lands, so triage keeps useful, redacted detail.
   */
  private describeError(error: unknown): string {
    const rendered =
      error instanceof FeedbackSinkError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.name
          : 'Unknown error';

    return rendered.length > FEEDBACK_LAST_ERROR_MAX_LENGTH
      ? rendered.slice(0, FEEDBACK_LAST_ERROR_MAX_LENGTH)
      : rendered;
  }
}
