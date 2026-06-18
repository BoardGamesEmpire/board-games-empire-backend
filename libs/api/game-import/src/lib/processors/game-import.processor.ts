import { DatabaseService, JobStatus } from '@bge/database';
import { ActorAwareWorkerHost } from '@bge/queue-actor-context';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { ImportEvents, JobNames, QueueNames } from '../constants/queue.constants';
import type {
  ExpansionImportJobPayload,
  GameImportJobPayload,
  ImportJobCompletedEvent,
  ImportJobFailedEvent,
  ImportJobResult,
} from '../interfaces/import-job.interface';
import { GameUpsertService } from '../services/game.service';
import { extractGameDataFromChildren } from '../utils/extract-game-data';

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
  ) {
    super();
  }

  protected processJob(job: Job<GameImportJobPayload | ExpansionImportJobPayload>): Promise<ImportJobResult> {
    switch (job.name) {
      case JobNames.GameImport: {
        return this.processBaseGame(job as Job<GameImportJobPayload>);
      }

      case JobNames.ExpansionImport: {
        return this.processExpansion(job as Job<ExpansionImportJobPayload>);
      }

      default: {
        throw new Error(`Unknown job name: ${job.name}`);
      }
    }
  }

  private async processBaseGame(job: Job<GameImportJobPayload>): Promise<ImportJobResult> {
    const { jobId, batchId, correlationId, gatewayId, userId } = job.data;

    // GameData is the return value of this job's GameFetch child, run
    // by the gateway-worker. BullMQ stores it under the child's queue:jobId key.
    const gameData = extractGameDataFromChildren(await job.getChildrenValues());

    this.logger.log(`Base game import: jobId=${jobId} externalId=${gameData.externalId}`);

    // Fetch processor already moved status to Running. This call updates
    // bullmqJobId for the import job specifically.
    await this.markRunning(jobId, job.id!.toString());

    const result = await this.gameUpsert.upsert(gameData, gatewayId);
    await this.markCompleted(jobId, result.gameId);

    this.events.emit(ImportEvents.JobCompleted, {
      jobId,
      batchId,
      gameId: result.gameId,
      gameTitle: gameData.title,
      externalId: gameData.externalId,
      thumbnail: gameData.thumbnailUrl ?? null,
      gameCreated: result.gameCreated,
      sourceCreated: result.sourceCreated,
      isExpansion: false,
      userId,
      gatewayId,
      correlationId,
    } satisfies ImportJobCompletedEvent);

    return result;
  }

  private async processExpansion(job: Job<ExpansionImportJobPayload>): Promise<ImportJobResult> {
    const { jobId, batchId, correlationId, gatewayId, userId, baseGameExternalId } = job.data;
    const gameData = extractGameDataFromChildren(await job.getChildrenValues());

    this.logger.log(`Expansion import: jobId=${jobId} externalId=${gameData.externalId}`);

    await this.markRunning(jobId, job.id!.toString());

    const result = await this.gameUpsert.upsertExpansion(gameData, baseGameExternalId, gatewayId);
    await this.markCompleted(jobId, result.gameId);

    this.events.emit(ImportEvents.JobCompleted, {
      jobId,
      batchId,
      gameId: result.gameId,
      gameTitle: gameData.title,
      thumbnail: gameData.thumbnailUrl ?? null,
      gameCreated: result.gameCreated,
      sourceCreated: result.sourceCreated,
      isExpansion: true,
      baseGameId: result.baseGameId,
      externalId: gameData.externalId,
      userId,
      gatewayId,
      correlationId,
    } satisfies ImportJobCompletedEvent);

    return result;
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GameImportJobPayload | ExpansionImportJobPayload>, error: Error): Promise<void> {
    const { jobId, batchId, correlationId } = job.data;

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

      await this.db.job.update({
        where: { id: jobId },
        data: { status: JobStatus.Failed, error: error.message },
      });

      this.events.emit(ImportEvents.JobFailed, {
        jobId,
        batchId,
        error: error.message,
        correlationId,
      } satisfies ImportJobFailedEvent);
    });
  }

  private markRunning(jobId: string, bullmqJobId: string) {
    return this.db.job.update({
      where: { id: jobId },
      data: { status: JobStatus.Running, startedAt: new Date(), bullmqJobId },
    });
  }

  private markCompleted(jobId: string, gameId: string) {
    return this.db.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.Completed,
        completedAt: new Date(),
        result: { gameId },
        gameId,
      },
    });
  }
}
