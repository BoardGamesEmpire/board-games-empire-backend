import { type Actor, AuditContextService } from '@bge/actor-context';
import { type JobActorMeta, type JobMetaEnvelope, wrapJobData } from '@bge/queue-actor-context';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { EXTENDED_NETWORK_JOB_RETRY } from './extended-network-job-options';
import {
  EXTENDED_NETWORK_QUEUE,
  type ExtendedNetworkJob,
  ExtendedNetworkJobNames,
} from './extended-network-queue.constants';

/**
 * How long a user's rebuild waits before it runs. A change to the same user
 * that lands meanwhile is merged into the waiting job, which reads the
 * friendships when it runs, so a burst of accepts costs one rebuild. The wait
 * never starts again, so changes that keep coming can't put the rebuild off.
 * An unfriend reaches the permissions once the job runs.
 */
const REBUILD_DELAY_MS = 2_000;

/**
 * Queues the extended network's rebuilds for friendship changes (#497). The
 * API calls it once a change is written. The worker runs the jobs.
 *
 * Per user, a job merges every change made before it starts. A change made
 * while it runs may be missing from what it read, so BullMQ keeps that change
 * (`keepLastIfActive`) and queues one more job when the running one finishes.
 * Never more than one job waits per user.
 */
@Injectable()
export class ExtendedNetworkProducer {
  private readonly logger = new Logger(ExtendedNetworkProducer.name);

  constructor(
    private readonly auditContext: AuditContextService,
    @InjectQueue(EXTENDED_NETWORK_QUEUE) private readonly queue: Queue<ExtendedNetworkJob & JobMetaEnvelope>,
  ) {}

  /**
   * Queues a rebuild around each user, side by side. Never rejects: the
   * friendship is already written, and failing its request would say it
   * wasn't. A rebuild that couldn't be queued is logged, and the daily
   * rebuild repairs its rows.
   *
   * A request doesn't wait for it. While the queue's Redis is unreachable an
   * add neither settles nor rejects: the client holds it until Redis is back,
   * and only then sends it. The actor and correlation id are read before the
   * first add, while the request's context still holds them.
   */
  async changed(userIds: readonly string[]): Promise<void> {
    const ids = [...new Set(userIds)];
    const meta: JobActorMeta = {
      actor: this.actorOf(ids),
      correlationId: this.auditContext.getCorrelationId() ?? randomUUID(),
    };

    await Promise.all(ids.map((userId) => this.queueRebuildAround(userId, meta)));
  }

  private async queueRebuildAround(userId: string, meta: JobActorMeta): Promise<void> {
    try {
      await this.queue.add(
        ExtendedNetworkJobNames.RebuildAround,
        wrapJobData({ userId }, meta),
        rebuildAroundOptions(userId),
      );
    } catch (error) {
      this.logger.warn(
        `Could not queue the extended network table rebuild around user ${userId}; the daily rebuild repairs its rows: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * The actor behind the change. A change with none is a bug, an entry point
   * that sets no actor, so it is reported rather than passed off as the
   * server's own work. Its rebuild still runs, under a reason that says so.
   */
  private actorOf(userIds: readonly string[]): Actor {
    const actor = this.auditContext.getActor();
    if (actor) {
      return actor;
    }

    this.logger.warn(
      `The friendship change around users ${userIds.join(', ')} has no actor, so its rebuild is queued ` +
        `as ${UNATTRIBUTED_CHANGE.reason}. The entry point that made the change sets no actor, which is a bug.`,
    );
    return UNATTRIBUTED_CHANGE;
  }
}

/** The actor a rebuild runs as when its change has none; its reason marks it as unattributed. */
const UNATTRIBUTED_CHANGE = { kind: 'system', reason: 'extended-network:unattributed-change' } as const satisfies Actor;

function rebuildAroundOptions(userId: string): JobsOptions {
  return {
    delay: REBUILD_DELAY_MS,
    deduplication: { id: `extended-network:${userId}`, keepLastIfActive: true },
    ...EXTENDED_NETWORK_JOB_RETRY,
  };
}
