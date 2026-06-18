import { DatabaseService, JobStatus } from '@bge/database';
import { GatewayRegistryService } from '@bge/gateway-registry';
import { ActorAwareWorkerHost } from '@bge/queue-actor-context';
import * as proto from '@board-games-empire/proto-gateway';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import { Job } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { QueueNames } from '../constants/queue.constants';
import type { ExpansionFetchJobPayload, GameFetchJobPayload } from '../interfaces/import-job.interface';

/**
 * Consumes fetch jobs in the gateway-worker. Each job calls a specific gateway's
 * FetchGame RPC via the shared GatewayRegistryService (no callback to the
 * coordinator). The return value is the resolved GameData, stored by BullMQ and
 * consumed by the parent import job via getChildrenValues().
 *
 * Extends ActorAwareWorkerHost: the originating actor + correlation are restored
 * into CLS for the duration of processJob, so gateway-registry reporting and any
 * downstream events are attributed to the user who triggered the import. Every
 * fetch job MUST be enqueued via wrapJobData (GameImportEnqueuerService does) —
 * the base rejects jobs without the __meta envelope; there is no fallback actor.
 *
 * Reports success/failure to the registry to feed auto-disable tracking.
 * failParentOnFailure on the flow's child opts ensures a persistent fetch
 * failure cascades to the parent import.
 */
@Processor(QueueNames.GatewayFetch)
export class GameFetchProcessor extends ActorAwareWorkerHost<
  GameFetchJobPayload | ExpansionFetchJobPayload,
  proto.GameData
> {
  private readonly logger = new Logger(GameFetchProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gatewayRegistry: GatewayRegistryService,
  ) {
    super();
  }

  protected async processJob(job: Job<GameFetchJobPayload | ExpansionFetchJobPayload>): Promise<proto.GameData> {
    const { jobId, gatewayId, externalId, locale, correlationId } = job.data;

    this.logger.log(`${job.name} jobId=${jobId} gatewayId=${gatewayId} externalId=${externalId} — fetching`);

    // Transition Job row Pending → Running idempotently. Multiple retries
    // still leave the row in Running; only the first attempt actually changes status.
    await this.db.job.updateMany({
      where: { id: jobId, status: JobStatus.Pending },
      data: { status: JobStatus.Running, startedAt: new Date(), bullmqJobId: job.id?.toString() },
    });

    // Resolve (lazily connecting on a cache miss) outside the try below:
    // connect() already feeds failure tracking on connection errors, so this
    // must not also be reported as a call failure. A missing/disabled gateway
    // or failed connect throws here, failing the job for BullMQ to retry — by
    // which time a newly-added gateway may have become connectable.
    const client = await this.gatewayRegistry.getServiceClient(gatewayId);

    try {
      const response = await firstValueFrom(client.fetchGame({ correlationId, externalId, locale }));

      if (!response.game) {
        throw new NotFoundException(
          `FetchGame returned no game data for gatewayId=${gatewayId} externalId=${externalId}. ` +
            `Status: ${response.status}${response.message ? ` — ${response.message}` : ''}`,
        );
      }

      this.gatewayRegistry.reportSuccess(gatewayId);
      this.logger.log(`${job.name} jobId=${jobId} externalId=${externalId} — fetch complete`);
      return response.game;
    } catch (err) {
      await this.gatewayRegistry.reportFailure(gatewayId, err);
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GameFetchJobPayload | ExpansionFetchJobPayload>, error: Error): Promise<void> {
    const { jobId } = job.data;

    // Only mark the DB job as failed after all retry attempts are exhausted.
    // BullMQ fires this event on every failed attempt; check attemptsMade vs
    // attempts to distinguish the final failure.
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      this.logger.warn(
        `${job.name} jobId=${jobId} attempt ${job.attemptsMade}/${job.opts.attempts ?? 1} failed: ${error.message}`,
      );
      return;
    }

    // Attribute the failure DB write to the originating actor, mirroring the
    // CLS scope opened around the successful fetch path in processJob.
    await this.runInActorScope(job, async () => {
      this.logger.error(`${job.name} jobId=${jobId} failed permanently`, error.stack);

      await this.db.job.update({
        where: { id: jobId },
        data: { status: JobStatus.Failed, error: error.message },
      });
    });
  }
}
