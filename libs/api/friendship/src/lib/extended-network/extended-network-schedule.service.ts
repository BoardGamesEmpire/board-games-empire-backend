import { AuditContextService, SystemActorScope } from '@bge/actor-context';
import { type JobMetaEnvelope, wrapJobData } from '@bge/queue-actor-context';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { EXTENDED_NETWORK_JOB_RETRY } from './extended-network-job-options';
import {
  EXTENDED_NETWORK_QUEUE,
  type ExtendedNetworkJob,
  ExtendedNetworkJobNames,
} from './extended-network-queue.constants';

const REBUILD_SCHEDULE_NAME = 'extended-network-rebuild';
const REBUILD_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Merges the requests for a full rebuild while one waits or runs: the boot of
 * several workers, or a boot beside the day's run. Unlike a fixed job id, it
 * is freed when the job ends, failed or not, so a kept failure never stops the
 * next day's run.
 */
const REBUILD_ALL_DEDUPLICATION_ID = 'extended-network:rebuild-all';

/**
 * Below every per-change job, which carries no priority, so a change's job
 * runs before a waiting full rebuild, and between two batches of a running
 * one: an unfriend waits for one batch at most. BullMQ takes jobs without a
 * priority first, and a full rebuild goes back to the queue after each batch.
 */
const REBUILD_ALL_PRIORITY = 10;

/**
 * The rebuilds take one advisory lock each, so they can't run side by side.
 * Held to one job at a time across every worker, a rebuild waits in the
 * queue, rather than in an open transaction on a database connection while
 * another worker's rebuild holds the lock.
 */
const EXTENDED_NETWORK_GLOBAL_CONCURRENCY = 1;

/**
 * Queues a full rebuild of the extended network from the friendships when the
 * worker starts, and daily (#497), so a rebuild that was lost or failed heals
 * without an operator. There's no setting for it. Worker-only, where
 * `ScheduleModule.forRoot()` runs the interval.
 */
@Injectable()
export class ExtendedNetworkScheduleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExtendedNetworkScheduleService.name);

  constructor(
    private readonly auditContext: AuditContextService,
    private readonly systemActorScope: SystemActorScope,
    @InjectQueue(EXTENDED_NETWORK_QUEUE) private readonly queue: Queue<ExtendedNetworkJob & JobMetaEnvelope>,
  ) {}

  /**
   * Not awaited. The queue's connection holds a command until Redis answers,
   * so with Redis down at start an awaited call would hold up the worker's
   * later bootstrap hooks, and the shutdown handlers registered after them,
   * until Redis came back (#497). The limit is still set before the rebuild
   * is queued.
   */
  onApplicationBootstrap(): void {
    void this.runOneAtATime()
      .then(() => this.queueRebuildAll())
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not prepare the extended network rebuilds at start; the next one runs in a day: ` +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
  }

  @Interval(REBUILD_SCHEDULE_NAME, REBUILD_INTERVAL_MS)
  async rebuildDaily(): Promise<void> {
    await this.queueRebuildAll();
  }

  /**
   * Never throws. Without the limit the rebuilds still run one at a time,
   * under the lock; each one waiting holds a connection meanwhile.
   */
  private async runOneAtATime(): Promise<void> {
    try {
      await this.queue.setGlobalConcurrency(EXTENDED_NETWORK_GLOBAL_CONCURRENCY);
    } catch (error) {
      this.logger.warn(
        `Could not hold the extended network rebuilds to one at a time across workers; the lock still does: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * Never throws. The worker starts without its first rebuild, and each
   * friendship change's own job keeps its rows current until the next run.
   */
  private queueRebuildAll(): Promise<void> {
    return this.systemActorScope.run(REBUILD_SCHEDULE_NAME, async () => {
      const meta = {
        actor: this.auditContext.getActorOrThrow(),
        correlationId: this.auditContext.getCorrelationId() ?? randomUUID(),
      };

      try {
        await this.queue.add(ExtendedNetworkJobNames.RebuildAll, wrapJobData({}, meta), {
          deduplication: { id: REBUILD_ALL_DEDUPLICATION_ID },
          priority: REBUILD_ALL_PRIORITY,
          ...EXTENDED_NETWORK_JOB_RETRY,
        });
      } catch (error) {
        this.logger.warn(
          `Could not queue the full extended network rebuild; the next one runs in a day: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    });
  }
}
