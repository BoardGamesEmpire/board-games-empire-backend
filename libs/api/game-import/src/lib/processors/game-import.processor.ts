import { DatabaseService, JobStatus, Prisma } from '@bge/database';
import { ActorAwareWorkerHost } from '@bge/queue-actor-context';
import { WebhookEventType, webhookEnvelope } from '@bge/webhooks';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { ImportEvents, JobNames, QueueNames } from '../constants/queue.constants';
import type {
  ExpansionImportJobPayload,
  GameImportJobPayload,
  ImportJobCompletedEvent,
  ImportJobResult,
  PersistedJobFailure,
  PersistedJobResult,
} from '../interfaces/import-job.interface';
import { ImportBatchCompletionService } from '../services/batch-completion.service';
import { GameUpsertService } from '../services/game.service';
import { emitJobFailedEvents } from '../utils/emit-job-failed';
import { extractGameDataFromChildren } from '../utils/extract-game-data';
import { sanitizeImportError } from '../utils/sanitize-import-error';

@Processor(QueueNames.GamesImport)
export class GameImportProcessor extends ActorAwareWorkerHost<
  GameImportJobPayload | ExpansionImportJobPayload,
  ImportJobResult
> {
  private readonly logger = new Logger(GameImportProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gameUpsert: GameUpsertService,
    private readonly events: EventEmitter2,
    private readonly batchCompletion: ImportBatchCompletionService,
  ) {
    super();
  }

  protected processJob(job: Job<GameImportJobPayload | ExpansionImportJobPayload>): Promise<ImportJobResult> {
    switch (job.name) {
      case JobNames.GameImport: {
        return this.processImport(job, false);
      }

      case JobNames.ExpansionImport: {
        return this.processImport(job as Job<ExpansionImportJobPayload>, true);
      }

      default: {
        throw new Error(`Unknown job name: ${job.name}`);
      }
    }
  }

  private async processImport(
    job: Job<GameImportJobPayload | ExpansionImportJobPayload>,
    isExpansion: boolean,
  ): Promise<ImportJobResult> {
    const { jobId, batchId, correlationId, gatewayId, userId } = job.data;

    // GameData is the return value of this job's fetch child, run by the
    // gateway-worker. BullMQ stores it under the child's queue:jobId key.
    const gameData = extractGameDataFromChildren(await job.getChildrenValues());

    this.logger.log(
      `${isExpansion ? 'Expansion' : 'Base game'} import: jobId=${jobId} externalId=${gameData.externalId}`,
    );

    // Fetch processor already moved status to Running and stamped startedAt on
    // the Pending → Running transition. This call only records the import job's
    // own bullmqJobId — it must not re-stamp startedAt, or the true start time
    // (which JobStarted semantics and the status endpoints report) would shift
    // later to when this parent job ran.
    await this.markRunning(jobId, job.id!.toString());

    const result = isExpansion
      ? await this.gameUpsert.upsertExpansion(
          gameData,
          (job.data as ExpansionImportJobPayload).baseGameExternalId,
          gatewayId,
        )
      : await this.gameUpsert.upsert(gameData, gatewayId);

    await this.markCompleted(jobId, {
      gameId: result.gameId,
      gameTitle: gameData.title,
      thumbnail: gameData.thumbnailUrl ?? null,
      platformGames: result.platformGames,
    });

    this.emitCompleted({
      jobId,
      batchId,
      gameId: result.gameId,
      gameTitle: gameData.title,
      externalId: gameData.externalId,
      thumbnail: gameData.thumbnailUrl ?? null,
      gameCreated: result.gameCreated,
      sourceCreated: result.sourceCreated,
      platformGames: result.platformGames,
      isExpansion,
      baseGameId: result.baseGameId,
      userId,
      gatewayId,
      correlationId,
    });

    await this.batchCompletion.checkAndEmit(batchId);

    return result;
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GameImportJobPayload | ExpansionImportJobPayload>, error: Error): Promise<void> {
    const { jobId, batchId, correlationId, gatewayId, externalId, userId } = job.data;

    const attempts = job.opts.attempts ?? 1;
    if (attempts > 1 && job.attemptsMade < attempts) {
      return this.logger.warn(
        `Import job failed but will retry: jobId=${jobId} attemptsMade=${job.attemptsMade} attempts=${attempts} error=${error.message}`,
      );
    }

    // Reconstruct the originating actor's CLS scope so the failure DB write and
    // the JobFailed event are attributed to the user who triggered the import,
    // mirroring the successful path in processJob.
    return this.runInActorScope(job, async () => {
      this.logger.error(`Import job failed: jobId=${jobId}`, error.stack);

      const sanitized = sanitizeImportError(error, 'persist');
      const persistedFailure: PersistedJobFailure = { errorCode: sanitized.code, error: sanitized.message };

      // Guarded transition: this event also fires for deferred cascade
      // failures (failParentOnFailure re-queues the parent with a `defa`
      // marker and the worker fails it here). When the fetch processor
      // already marked this row Failed with the real gateway error, skip —
      // don't overwrite it with the vaguer "child ... failed" message or
      // re-emit events for an already-terminal job.
      //
      // `error` (raw, DB column only) is for operator debugging via direct
      // DB access. `result` (sanitized) is what GET /games/import/:batchId
      // — deliberately not owner-scoped — actually returns; the raw column
      // must never be serialized into that response.
      const transitioned = await this.db.job.updateMany({
        where: { id: jobId, status: { in: [JobStatus.Pending, JobStatus.Running] } },
        data: {
          status: JobStatus.Failed,
          error: error.message,
          result: persistedFailure as unknown as Prisma.InputJsonValue,
        },
      });

      if (transitioned.count === 0) {
        return;
      }

      emitJobFailedEvents(
        this.events,
        {
          jobId,
          batchId,
          externalId,
          gatewayId,
          isExpansion: job.name === JobNames.ExpansionImport,
          userId,
          correlationId,
        },
        sanitized,
      );

      await this.batchCompletion.checkAndEmit(batchId);
    });
  }

  /**
   * Emits the in-process completion event plus, for imports that added new
   * content, the webhook-eligible `game.game.imported.v1` envelope. Re-imports
   * (sourceCreated=false) skip the webhook to match the in-process listeners'
   * semantics — subscribers hear "imported" only when a source is new; batch
   * completion and REST polling still cover re-import job status. The
   * occurrenceId is the Job row id — stable across re-emits of the same
   * logical completion, so duplicate deliveries dedup at the webhook queue.
   */
  private emitCompleted(event: ImportJobCompletedEvent): void {
    this.events.emit(ImportEvents.JobCompleted, event);

    if (!event.sourceCreated) {
      return;
    }

    this.events.emit(
      WebhookEventType.GameImported,
      webhookEnvelope({
        subjectId: event.gameId,
        occurrenceId: event.jobId,
        data: {
          jobId: event.jobId,
          batchId: event.batchId,
          gameId: event.gameId,
          gameTitle: event.gameTitle,
          thumbnail: event.thumbnail,
          gameCreated: event.gameCreated,
          sourceCreated: event.sourceCreated,
          platformGames: event.platformGames,
          isExpansion: event.isExpansion,
          baseGameId: event.baseGameId,
          gatewayId: event.gatewayId,
          externalId: event.externalId,
        },
      }),
    );
  }

  private markRunning(jobId: string, bullmqJobId: string) {
    // startedAt is owned by the fetch processor (set on the first
    // Pending → Running transition); deliberately not touched here so the
    // reported start time isn't pushed later to when this parent job ran.
    return this.db.job.update({
      where: { id: jobId },
      data: { status: JobStatus.Running, bullmqJobId },
    });
  }

  /**
   * Persists the durable completion summary the REST status endpoint
   * (GET /games/import/:batchId) serves — notably platformGames, since
   * collections key on PlatformGame.id rather than Game.id.
   */
  private markCompleted(jobId: string, result: PersistedJobResult) {
    return this.db.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.Completed,
        completedAt: new Date(),
        result: result as unknown as Prisma.InputJsonValue,
        gameId: result.gameId,
      },
    });
  }
}
