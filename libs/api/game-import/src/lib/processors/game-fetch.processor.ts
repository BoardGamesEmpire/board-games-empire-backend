import { DatabaseService, JobStatus, Prisma } from '@bge/database';
import { GatewayRegistryService } from '@bge/gateway-registry';
import { ActorAwareWorkerHost } from '@bge/queue-actor-context';
import { WebhookEventType, webhookEnvelope } from '@bge/webhooks';
import * as proto from '@boardgamesempire/proto-gateway';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { JobNames, QueueNames } from '../constants/queue.constants';
import { ImportJobStartedEvent } from '../events/import.events';
import type {
  ExpansionFetchJobPayload,
  GameFetchJobPayload,
  PersistedJobFailure,
} from '../interfaces/import-job.interface';
import { ImportBatchCompletionService } from '../services/batch-completion.service';
import { emitJobFailedEvents } from '../utils/emit-job-failed';
import { sanitizeImportError } from '../utils/sanitize-import-error';

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
    private readonly events: EventEmitter2,
    private readonly batchCompletion: ImportBatchCompletionService,
  ) {
    super();
  }

  protected async processJob(job: Job<GameFetchJobPayload | ExpansionFetchJobPayload>): Promise<proto.GameData> {
    const initiatedAt = new Date();
    const { jobId, batchId, gatewayId, externalId, locale, correlationId } = job.data;

    this.logger.log(`${job.name} jobId=${jobId} gatewayId=${gatewayId} externalId=${externalId} — fetching`);

    // Transition Job row Pending → Running idempotently. Multiple retries
    // still leave the row in Running; only the first attempt actually changes
    // status — and only that first transition emits the started events.
    const transitioned = await this.db.job.updateMany({
      where: { id: jobId, status: JobStatus.Pending },
      data: { status: JobStatus.Running, startedAt: new Date(), bullmqJobId: job.id?.toString() },
    });

    if (transitioned.count === 1) {
      const isExpansion = job.name === JobNames.ExpansionFetch;

      // Actor / source / correlationId ride CLS (restored per job by
      // ActorAwareWorkerHost), so the event carries only row state + context.
      this.events.emit(
        ImportJobStartedEvent.eventName,
        new ImportJobStartedEvent(
          { id: jobId, status: JobStatus.Pending },
          { id: jobId, status: JobStatus.Running },
          { batchId, gatewayId, externalId, isExpansion },
          initiatedAt,
        ),
      );

      this.events.emit(
        WebhookEventType.ImportJobStarted,
        webhookEnvelope({
          subjectId: jobId,
          occurrenceId: jobId,
          data: { jobId, batchId, gatewayId, externalId, isExpansion },
        }),
      );
    }

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
    const { jobId, batchId, gatewayId, externalId } = job.data;

    // Only mark the DB job as failed after all retry attempts are exhausted.
    // BullMQ fires this event on every failed attempt; check attemptsMade vs
    // attempts to distinguish the final failure.
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      this.logger.warn(
        `${job.name} jobId=${jobId} attempt ${job.attemptsMade}/${job.opts.attempts ?? 1} failed: ${error.message}`,
      );
      return;
    }

    // Start of the terminal-failure unit of work (guarded write + emits).
    const initiatedAt = new Date();

    // Attribute the failure DB write to the originating actor, mirroring the
    // CLS scope opened around the successful fetch path in processJob.
    await this.runInActorScope(job, async () => {
      this.logger.error(`${job.name} jobId=${jobId} failed permanently`, error.stack);

      const isExpansion = job.name === JobNames.ExpansionFetch;
      const sanitized = sanitizeImportError(error, 'fetch');
      const persistedFailure: PersistedJobFailure = { errorCode: sanitized.code, error: sanitized.message };

      // Guarded transition: this Job row is shared with the parent import
      // job, whose deferred cascade failure (failParentOnFailure sets a
      // `defa` marker and re-queues it) fires GameImportProcessor.onFailed
      // in another process — possibly before this handler's write lands.
      // Whichever handler wins the Pending/Running → Failed transition
      // emits the failure events; the loser must not double-emit.
      //
      // `error` (raw, DB column only) is for operator debugging via direct
      // DB access. `result` (sanitized) is what GET /games/import/:batchId
      // — deliberately not owner-scoped — actually returns.
      const transitioned = await this.db.job.updateMany({
        where: { id: jobId, status: { in: [JobStatus.Pending, JobStatus.Running] } },
        data: {
          status: JobStatus.Failed,
          error: error.message,
          result: persistedFailure as unknown as Prisma.InputJsonValue,
        },
      });

      if (transitioned.count === 0) {
        // The import-side cascade handler won the race: it already persisted
        // its sanitized {errorCode,error} to Job.result AND emitted the
        // webhook / notification off it. Backfill ONLY the raw Job.error
        // column (operator/debug) with the real gateway error — deliberately
        // NOT result. Rewriting the classification here (fetch → GATEWAY_ERROR
        // over the winner's INTERNAL_ERROR) would make the REST status
        // endpoint disagree with the already-emitted webhook/notification,
        // breaking the guarantee that every external surface shares one
        // classification. Consistency wins over the marginally more accurate
        // code; the real cause is preserved in Job.error for operators.
        await this.db.job.updateMany({
          where: { id: jobId, status: JobStatus.Failed },
          data: { error: error.message },
        });
        return;
      }

      emitJobFailedEvents(this.events, { jobId, batchId, gatewayId, externalId, isExpansion }, sanitized, initiatedAt);

      await this.batchCompletion.checkAndEmit(batchId);
    });
  }
}
