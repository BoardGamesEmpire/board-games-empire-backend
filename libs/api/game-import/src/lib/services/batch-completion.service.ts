import { DatabaseService, JobStatus, JobType } from '@bge/database';
import { WebhookEventType, webhookEnvelope } from '@bge/webhooks';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ImportEvents } from '../constants/queue.constants';
import type { ImportBatchCompletedEvent, ImportBatchCounts } from '../interfaces/import-job.interface';
import { deriveBatchStatus, isTerminal } from '../utils/batch-status';

/**
 * Detects import-batch completion. Called by both the import processor
 * (apps/worker) and the fetch processor (apps/gateway-worker) after any
 * terminal Job-row write; whichever process transitions the batch's last
 * job emits `ImportEvents.BatchComplete` plus the webhook-eligible
 * `game.import-batch.completed.v1` envelope.
 *
 * Exactly-once is best-effort: two jobs reaching terminal state
 * concurrently in different processes can both observe "all terminal"
 * and double-emit. Webhook deliveries dedup on the batchId occurrenceId;
 * in-process listeners must tolerate a duplicate. The REST status
 * endpoint derives batch status from the Job rows directly and is
 * unaffected.
 */
@Injectable()
export class ImportBatchCompletionService {
  private readonly logger = new Logger(ImportBatchCompletionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Emits batch-completion events when every job in the batch is
   * terminal. Never throws — a completion-signal failure must not fail
   * the job write that triggered it.
   */
  async checkAndEmit(batchId: string): Promise<void> {
    try {
      // Cheap gate first: this runs after every terminal write in the batch,
      // so the common case (batch still open) must not fetch full rows.
      const openJobs = await this.db.job.count({
        where: { batchId, type: JobType.GameImport, status: { in: [JobStatus.Pending, JobStatus.Running] } },
      });
      if (openJobs > 0) {
        return;
      }

      const jobs = await this.db.job.findMany({
        where: { batchId, type: JobType.GameImport },
        select: { id: true, status: true, parentJobId: true, userId: true, payload: true },
      });

      if (jobs.length === 0 || jobs.some((job) => !isTerminal(job.status))) {
        return;
      }

      const baseJob = jobs.find((job) => job.parentJobId === null) ?? jobs[0];
      const payload = (baseJob.payload ?? {}) as { correlationId?: string };
      const status = deriveBatchStatus(jobs.map((job) => job.status));

      const counts = jobs.reduce<ImportBatchCounts>(
        (acc, job) => {
          acc.completed += job.status === JobStatus.Completed ? 1 : 0;
          acc.failed += job.status === JobStatus.Failed ? 1 : 0;
          acc.cancelled += job.status === JobStatus.Cancelled ? 1 : 0;
          return acc;
        },
        { total: jobs.length, completed: 0, failed: 0, cancelled: 0 },
      );

      this.logger.log(`Import batch complete: batchId=${batchId} status=${status} total=${counts.total}`);

      // Aggregate signal over many rows (each Job transition is audited
      // individually) — deliberately a plain payload, not a MutationEvent,
      // so the audit listener intentionally ignores it.
      this.events.emit(ImportEvents.BatchComplete, {
        batchId,
        baseJobId: baseJob.id,
        correlationId: payload.correlationId ?? '',
        status,
        counts,
        userId: baseJob.userId,
      } satisfies ImportBatchCompletedEvent);

      this.events.emit(
        WebhookEventType.ImportBatchCompleted,
        webhookEnvelope({
          subjectId: baseJob.id,
          occurrenceId: batchId,
          data: { batchId, baseJobId: baseJob.id, status, counts },
        }),
      );
    } catch (err) {
      this.logger.error(`Batch completion check failed for batchId=${batchId}`, err instanceof Error ? err.stack : err);
    }
  }
}
