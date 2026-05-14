import { DatabaseService, JobStatus } from '@bge/database';
import { GatewayRegistryService } from '@bge/gateway-registry';
import * as proto from '@board-games-empire/proto-gateway';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import { Job } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { QueueNames } from '../constants/queue.constants';
import type { ExpansionFetchJobPayload, GameFetchJobPayload } from '../interfaces/import-job.interface';

/**
 * Consumes fetch jobs from the gateway-worker. Each job calls a
 * specific gateway's FetchGame RPC via the shared GatewayRegistryService
 * (no callback to the coordinator). The job's return value is the
 * resolved GameData, stored by BullMQ and consumed by the parent import
 * job via getChildrenValues().
 *
 * Reports success/failure to the registry to feed the auto-disable
 * tracking. failParentOnFailure on the flow's child opts ensures a
 * persistent fetch failure cascades to the parent import.
 */
@Processor(QueueNames.GatewayFetch)
export class GameFetchProcessor extends WorkerHost {
  private readonly logger = new Logger(GameFetchProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gatewayRegistry: GatewayRegistryService,
  ) {
    super();
  }

  async process(job: Job<GameFetchJobPayload | ExpansionFetchJobPayload>): Promise<proto.GameData> {
    const { jobId, gatewayId, externalId, locale, correlationId } = job.data;

    this.logger.log(`${job.name} jobId=${jobId} gatewayId=${gatewayId} externalId=${externalId} — fetching`);

    // Transition Job row Pending → Running idempotently. Multiple retries
    // still leave the row in Running; only the first attempt actually changes status.
    await this.db.job.updateMany({
      where: { id: jobId, status: JobStatus.Pending },
      data: { status: JobStatus.Running, startedAt: new Date(), bullmqJobId: job.id?.toString() },
    });

    try {
      const client = this.gatewayRegistry.getServiceClient(gatewayId);
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

    this.logger.error(`${job.name} jobId=${jobId} failed permanently`, error.stack);

    await this.db.job.update({
      where: { id: jobId },
      data: { status: JobStatus.Failed, error: error.message },
    });
  }
}
