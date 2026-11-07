import { ActorAwareWorkerHost, type JobMetaEnvelope } from '@bge/queue-actor-context';
import { Processor } from '@nestjs/bullmq';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import {
  EXTENDED_NETWORK_QUEUE,
  type ExtendedNetworkJob,
  ExtendedNetworkJobNames,
} from './extended-network-queue.constants';
import { type ExtendedNetworkRebuildResult, ExtendedNetworkService } from './extended-network.service';

type ExtendedNetworkJobData = ExtendedNetworkJob & JobMetaEnvelope;

/**
 * Runs the extended network's rebuilds in the worker (#497).
 * `ActorAwareWorkerHost` restores the actor that queued the job, the user
 * whose friendship changed or the system, so the rebuild is attributed to it.
 * A job this processor can't read fails for good: its data never changes, so
 * a retry would fail the same way.
 *
 * A full rebuild runs one batch of users each time the worker takes it. After
 * every batch but the last it records where it got to and goes back to the
 * queue: below every change's job by its priority, so those run first, and
 * still holding its deduplication id, so a full rebuild queued meanwhile
 * merges into it. A retry starts from the batch that failed.
 */
@Processor(EXTENDED_NETWORK_QUEUE)
export class ExtendedNetworkProcessor extends ActorAwareWorkerHost<
  ExtendedNetworkJobData,
  ExtendedNetworkRebuildResult
> {
  constructor(private readonly extendedNetwork: ExtendedNetworkService) {
    super();
  }

  protected async processJob(
    job: Job<ExtendedNetworkJobData, ExtendedNetworkRebuildResult>,
    token?: string,
  ): Promise<ExtendedNetworkRebuildResult> {
    switch (job.name) {
      case ExtendedNetworkJobNames.RebuildAround: {
        const { userId } = job.data;

        if (typeof userId !== 'string' || userId.length === 0) {
          throw new UnrecoverableError(`Job ${job.queueName}#${job.id} rebuilds around no user`);
        }

        return this.extendedNetwork.rebuildAround(userId);
      }

      case ExtendedNetworkJobNames.RebuildAll:
        return this.rebuildAllBatch(job, token);

      default:
        throw new UnrecoverableError(
          `Job ${job.queueName}#${job.id} has a name no extended network job uses: ${job.name}`,
        );
    }
  }

  /**
   * Runs the full rebuild's next batch. With users left, saves the progress
   * and moves the job back to the queue, then throws `DelayedError`, which
   * tells BullMQ the job neither completed nor failed. The progress is saved
   * first: a worker lost between the two runs the next batch, not this one.
   */
  private async rebuildAllBatch(
    job: Job<ExtendedNetworkJobData, ExtendedNetworkRebuildResult>,
    token: string | undefined,
  ): Promise<ExtendedNetworkRebuildResult> {
    const { after, removed = 0, written = 0 } = job.data;
    const batch = await this.extendedNetwork.rebuildAllBatch(after ?? null);
    const totals = { removed: removed + batch.removed, written: written + batch.written };

    if (batch.next === null) {
      return totals;
    }

    await job.updateData({ ...job.data, after: batch.next, ...totals });
    await job.moveToDelayed(Date.now(), token);
    throw new DelayedError();
  }
}
