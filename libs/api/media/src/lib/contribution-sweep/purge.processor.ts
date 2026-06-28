import { ActorAwareWorkerHost, type JobMetaEnvelope } from '@bge/queue-actor-context';
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MediaQueueNames } from '../constants/media-queue.constants';
import type { PurgeContributionJob } from '../interfaces/purge-contribution-job.interface';
import { MediaContributionPurgeService } from './purge.service';

/**
 * Consumes purge jobs in the worker. ActorAwareWorkerHost restores the `system`
 * actor + correlation from the envelope, so the deletes and notification are
 * attributed to the originating sweep. Throws on failure so BullMQ owns retry.
 */
@Processor(MediaQueueNames.ContributionSweep)
export class MediaContributionPurgeProcessor extends ActorAwareWorkerHost<PurgeContributionJob & JobMetaEnvelope> {
  constructor(private readonly purge: MediaContributionPurgeService) {
    super();
  }

  protected async processJob(job: Job<PurgeContributionJob & JobMetaEnvelope>): Promise<void> {
    await this.purge.purge(job.data);
  }
}
