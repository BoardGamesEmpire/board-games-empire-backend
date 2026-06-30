import { ActorAwareWorkerHost, type JobMetaEnvelope } from '@bge/queue-actor-context';
import {
  DriverNotRegisteredError,
  InsufficientStorageError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import { Processor } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { MediaQueueNames } from '../constants/media-queue.constants';
import type { PurgeContributionJob } from '../interfaces/purge-contribution-job.interface';
import { MediaContributionPurgeService } from './purge.service';

/**
 * Consumes purge jobs in the worker. ActorAwareWorkerHost restores the `system`
 * actor + correlation from the envelope, so the deletes and notification are
 * attributed to the originating sweep.
 *
 * Storage failures are classified for BullMQ: a retryable outage (transient I/O,
 * a briefly-unmounted volume) is rethrown so the queue retries with backoff; a
 * terminal condition (no space, permission denied, misconfigured/unregistered
 * driver — #100) becomes `UnrecoverableError` so it doesn't burn the attempt
 * budget. Anything unmodeled propagates unchanged for normal retry/park handling.
 */
@Processor(MediaQueueNames.ContributionSweep)
export class MediaContributionPurgeProcessor extends ActorAwareWorkerHost<PurgeContributionJob & JobMetaEnvelope> {
  constructor(private readonly purge: MediaContributionPurgeService) {
    super();
  }

  protected async processJob(job: Job<PurgeContributionJob & JobMetaEnvelope>): Promise<void> {
    try {
      await this.purge.purge(job.data);
    } catch (error) {
      if (this.isTerminal(error)) {
        throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
      }
      throw error; // retryable / unmodeled — BullMQ retries with backoff
    }
  }

  private isTerminal(error: unknown): boolean {
    if (error instanceof StorageUnavailableError) {
      return !error.retryable;
    }

    return (
      error instanceof InsufficientStorageError ||
      error instanceof StorageMisconfiguredError ||
      error instanceof DriverNotRegisteredError
    );
  }
}
