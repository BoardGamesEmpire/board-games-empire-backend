import { AuditContextService, SystemActorScope } from '@bge/actor-context';
import { ContributionOrigin, DatabaseService, MediaContributionStatus } from '@bge/database';
import { type JobActorMeta, wrapJobData } from '@bge/queue-actor-context';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import * as crypto from 'node:crypto';
import { MediaJobNames, MediaQueueNames } from '../constants/media-queue.constants';
import type { PurgeContributionJob } from '../interfaces/purge-contribution-job.interface';

const SWEEP_INTERVAL_NAME = 'media-contribution-sweep';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly; reclaim windows are days
const SWEEP_BATCH_SIZE = 200; // bounded per tick; a backlog drains across ticks
const PURGE_ATTEMPTS = 3;
const PURGE_BACKOFF_MS = 5_000;
const PURGE_FAILED_RETENTION = 50;

@Injectable()
export class MediaContributionSweepService {
  private readonly logger = new Logger(MediaContributionSweepService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditContextService,
    private readonly systemActorScope: SystemActorScope,
    @InjectQueue(MediaQueueNames.ContributionSweep) private readonly queue: Queue<PurgeContributionJob>,
  ) {}

  /**
   * Periodic backstop (worker-only — where ScheduleModule + MediaSweepModule are
   * present). Scans inside a `system` actor scope and enqueues one purge job per
   * eligible contribution; the processor does the deletes with retry/backoff.
   */
  @Interval(SWEEP_INTERVAL_NAME, SWEEP_INTERVAL_MS)
  async sweepOnInterval(): Promise<void> {
    await this.systemActorScope.run('media-contribution-sweep', () => this.dispatch());
  }

  /**
   * Enqueues a purge job for each DirectUpload contribution that was rejected and
   * whose reclaim window has closed, regardless of which driver holds the bytes —
   * the purge processor resolves the driver by the object's recorded slug (#100).
   * Public for tests / admin tooling; assumes an actor scope is active.
   */
  async dispatch(): Promise<{ enqueued: number }> {
    const meta: JobActorMeta = {
      actor: this.audit.getActorOrThrow(),
      correlationId: this.audit.getCorrelationId() ?? crypto.randomUUID(),
    };

    const eligible = await this.db.mediaContribution.findMany({
      where: {
        status: MediaContributionStatus.Rejected,
        origin: ContributionOrigin.DirectUpload,
        reclaimDeadline: { lte: new Date() },
      },
      select: {
        id: true,
        mediaObjectId: true,
        contributedById: true,
        subjectType: true,
        subjectId: true,
        mediaObject: { select: { driverKey: true, driverSlug: true } },
      },
      take: SWEEP_BATCH_SIZE,
    });

    for (const contribution of eligible) {
      const payload: PurgeContributionJob = {
        contributionId: contribution.id,
        mediaObjectId: contribution.mediaObjectId,
        driverKey: contribution.mediaObject.driverKey,
        driverSlug: contribution.mediaObject.driverSlug,
        contributedById: contribution.contributedById,
        subjectType: contribution.subjectType,
        subjectId: contribution.subjectId,
      };

      await this.queue.add(MediaJobNames.PurgeContribution, wrapJobData(payload, meta), {
        jobId: contribution.id, // dedup: an already-queued contribution isn't re-enqueued across ticks
        attempts: PURGE_ATTEMPTS,
        backoff: { type: 'exponential', delay: PURGE_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: { count: PURGE_FAILED_RETENTION },
      });
    }

    if (eligible.length > 0) {
      this.logger.log(`Enqueued ${eligible.length} contribution purge job(s)`);
    }
    return { enqueued: eligible.length };
  }
}
