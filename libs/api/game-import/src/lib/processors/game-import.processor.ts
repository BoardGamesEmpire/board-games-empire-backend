import { DatabaseService, JobStatus, Prisma, type ContentFormat } from '@bge/database';
import { ActorAwareWorkerHost, extractJobMeta } from '@bge/queue-actor-context';
import { guardWorkerEvent } from '@bge/utils';
import { WebhookEventType, webhookEnvelope } from '@bge/webhooks';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { JobNames, QueueNames } from '../constants/queue.constants';
import { ImportJobCompletedEvent } from '../events/import.events';
import {
  ImportJobOrigin,
  type ExpansionImportJobPayload,
  type GameImportJobPayload,
  type ImportJobResult,
  type PersistedJobFailure,
  type PersistedJobResult,
} from '../interfaces/import-job.interface';
import { ImportBatchCompletionService } from '../services/batch-completion.service';
import { ExpansionSpawnerService } from '../services/expansion-spawner.service';
import { GameUpsertService } from '../services/game.service';
import { emitJobFailedEvents } from '../utils/emit-job-failed';
import { extractGameDataFromChildren } from '../utils/extract-game-data';
import { ImportErrorCode, importErrorMessage, sanitizeImportError } from '../utils/sanitize-import-error';

/**
 * Persists each game of an import batch, in apps/worker, from the GameData its
 * fetch child returned.
 *
 * A requested game, once persisted, adds the flows of the expansions chosen
 * with it. Any game the request named — the requested game or a chosen
 * expansion — that needs a base game the game catalog lacks adds that base
 * game to the batch; an added base game adds none (#971). Base game links are
 * made by whichever of the two games persists second, so the order the flows
 * finish in doesn't matter.
 */
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
    private readonly expansionSpawner: ExpansionSpawnerService,
  ) {
    super();
  }

  protected processJob(job: Job<GameImportJobPayload | ExpansionImportJobPayload>): Promise<ImportJobResult> {
    switch (job.name) {
      case JobNames.GameImport:
      case JobNames.ExpansionImport: {
        return this.processImport(job);
      }

      default: {
        throw new Error(`Unknown job name: ${job.name}`);
      }
    }
  }

  private async processImport(job: Job<GameImportJobPayload | ExpansionImportJobPayload>): Promise<ImportJobResult> {
    const initiatedAt = new Date();
    const { jobId, batchId, gatewayId, origin } = job.data;

    // GameData is the return value of this job's fetch child, run by the
    // gateway-worker. BullMQ stores it under the child's queue:jobId key.
    const gameData = extractGameDataFromChildren(await job.getChildrenValues());

    this.logger.log(`${origin} game import: jobId=${jobId} externalId=${gameData.externalId}`);

    // Fetch processor already moved status to Running and stamped startedAt on
    // the Pending → Running transition. This call only records the import job's
    // own bullmqJobId — it must not re-stamp startedAt, or the true start time
    // (which JobStarted semantics and the status endpoints report) would shift
    // later to when this parent job ran.
    await this.markRunning(jobId, job.id!.toString());

    const contentFormat = await this.contentFormatOf(gatewayId);
    // A chosen expansion falls back on the requested game as its base game
    // when its DataGateway names none (#971).
    const result = await this.gameUpsert.upsert(
      gameData,
      gatewayId,
      contentFormat,
      origin === ImportJobOrigin.ChosenExpansion
        ? (job.data as ExpansionImportJobPayload).requestedExternalId
        : undefined,
    );

    // The requested game's GameSource now exists, so the expansions chosen
    // with it can fall back on it. Spawn their flows BEFORE marking it
    // Completed: the freshly-created Pending expansion rows must be visible to
    // batch-completion so it can't fire on the requested game alone.
    // Idempotent, so a retry after a mid-spawn crash converges rather than
    // duplicating work.
    if (origin === ImportJobOrigin.Requested) {
      await this.spawnExpansions(job as Job<GameImportJobPayload>);
    }

    // A game that needs a base game the game catalog lacks adds it to the
    // batch, before Completed for the same reason. Only the games the request
    // named do: an added base game never adds another (#971).
    if (result.baseGameToAdd && origin !== ImportJobOrigin.AddedBaseGame) {
      await this.spawnBaseGame(job, result.baseGameToAdd);
    }

    const completed = await this.markCompleted(jobId, {
      gameId: result.gameId,
      gameTitle: gameData.title,
      thumbnail: gameData.thumbnailUrl ?? null,
      platformGames: result.platformGames,
    });

    if (completed.count === 0) {
      // The row was already terminal — e.g. cancelled by its base's failure
      // sweep while this expansion's flow was in flight. The upsert above is
      // idempotent, so the data is still persisted; but the terminal write that
      // won already emitted for this job and ran batch completion, so don't
      // emit a contradictory second completion here.
      this.logger.warn(`Import for jobId=${jobId} hit an already-terminal row; skipping completion events`);
      return result;
    }

    // Actor / source / correlationId ride CLS (restored per job by
    // ActorAwareWorkerHost), so the event carries only row state + context.
    this.emitCompleted(
      new ImportJobCompletedEvent(
        { id: jobId, status: JobStatus.Running },
        { id: jobId, status: JobStatus.Completed, gameId: result.gameId },
        {
          batchId,
          gatewayId,
          externalId: gameData.externalId,
          origin,
          gameTitle: gameData.title,
          thumbnail: gameData.thumbnailUrl ?? null,
          gameCreated: result.gameCreated,
          sourceCreated: result.sourceCreated,
          platformGames: result.platformGames,
          baseGameIds: result.baseGameIds,
          isExpansion: result.isExpansion,
        },
        initiatedAt,
      ),
    );

    await this.batchCompletion.checkAndEmit(batchId);

    return result;
  }

  /**
   * The content format the DataGateway's free text arrives in, as its last
   * interview stored it. Null when it declared none, or when its row is gone,
   * and the text is then read as plain text.
   */
  private async contentFormatOf(gatewayId: string): Promise<ContentFormat | null> {
    const gateway = await this.db.dataGateway.findUnique({
      where: { id: gatewayId },
      select: { contentFormat: true },
    });

    return gateway?.contentFormat ?? null;
  }

  /**
   * Spawns the flows of the expansions chosen with a just-persisted requested
   * game. The spawn list comes from its job's own payload, and the originating
   * actor is re-derived from the job meta so the expansion jobs are attributed
   * to the same user. Row creation + enqueue (and their idempotency) live in
   * ExpansionSpawnerService.
   */
  private async spawnExpansions(job: Job<GameImportJobPayload>): Promise<void> {
    const data = job.data;
    const expansionExternalIds = data.expansionExternalIds ?? [];
    if (expansionExternalIds.length === 0) {
      return;
    }

    const meta = extractJobMeta(job.data);
    if (!meta) {
      // Unreachable in practice: ActorAwareWorkerHost.process rejects jobs
      // lacking the meta envelope before processJob runs. Guard defensively so
      // a spawned job can never lose actor attribution silently.
      throw new Error(`Cannot spawn expansions for job ${job.id}: missing actor meta envelope`);
    }

    await this.expansionSpawner.spawn(
      {
        baseJobId: data.jobId,
        batchId: data.batchId,
        correlationId: data.correlationId,
        gatewayId: data.gatewayId,
        requestedExternalId: data.externalId,
        expansionExternalIds,
        locale: data.locale,
        initiatorType: data.initiatorType,
        userId: data.userId,
      },
      meta,
    );
  }

  /**
   * Adds the base game a just-persisted game needs to its import batch, under
   * that game's job and attributed to the same actor (#971).
   */
  private async spawnBaseGame(job: Job<GameImportJobPayload>, externalId: string): Promise<void> {
    const data = job.data;
    const meta = extractJobMeta(job.data);
    if (!meta) {
      // Unreachable in practice, as for spawnExpansions.
      throw new Error(`Cannot add a base game for job ${job.id}: missing actor meta envelope`);
    }

    await this.expansionSpawner.spawnBaseGame(
      {
        parentJobId: data.jobId,
        batchId: data.batchId,
        correlationId: data.correlationId,
        gatewayId: data.gatewayId,
        externalId,
        locale: data.locale,
        initiatorType: data.initiatorType,
        userId: data.userId,
      },
      meta,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GameImportJobPayload | ExpansionImportJobPayload>, error: Error): Promise<void> {
    const { jobId, batchId, gatewayId, externalId, origin } = job.data;

    const attempts = job.opts.attempts ?? 1;
    if (attempts > 1 && job.attemptsMade < attempts) {
      return this.logger.warn(
        `Import job failed but will retry: jobId=${jobId} attemptsMade=${job.attemptsMade} attempts=${attempts} error=${error.message}`,
      );
    }

    // Start of the terminal-failure unit of work (guarded write + emits).
    const initiatedAt = new Date();

    // Reconstruct the originating actor's CLS scope so the failure DB write and
    // the JobFailed event are attributed to the user who triggered the import,
    // mirroring the successful path in processJob. Guarded so an error in the
    // bookkeeping/emit path can't escape this `failed` listener as an unhandled
    // rejection and crash the worker (taking down every in-flight job with it).
    await guardWorkerEvent(this.logger, `game import job ${jobId} terminal-failure handling`, () =>
      this.runInActorScope(job, async () => {
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

        // Cancel any still-Pending rows this job added to the batch: the
        // expansions chosen with a requested game, or the base game a game
        // needed (#971), so any job can have them. In the common cases the job
        // never persisted, so it added no rows and this is a no-op — but it
        // guarantees the batch can't hang Running forever on orphaned children
        // (e.g. a crash after row creation but before their flows enqueued,
        // with retries then exhausted).
        //
        // Deliberately scoped to Pending only: a child already Running when
        // this sweep fires is left alone and proceeds to its own guarded
        // markRunning/markCompleted normally — it was never a cancellation
        // target, not "healing" from one. Conversely, a Pending row this sweep
        // does cancel is safe from resurrection: markRunning/markCompleted only
        // transition rows still in [Pending, Running], so they silently no-op
        // against an already-Cancelled row instead of overwriting it.
        const cancellation: PersistedJobFailure = {
          errorCode: ImportErrorCode.BaseImportFailed,
          error: importErrorMessage(ImportErrorCode.BaseImportFailed),
        };
        await this.db.job.updateMany({
          where: { parentJobId: jobId, status: JobStatus.Pending },
          data: { status: JobStatus.Cancelled, result: cancellation as unknown as Prisma.InputJsonValue },
        });

        emitJobFailedEvents(this.events, { jobId, batchId, externalId, gatewayId, origin }, sanitized, initiatedAt);

        await this.batchCompletion.checkAndEmit(batchId);
      }),
    );
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
    this.events.emit(ImportJobCompletedEvent.eventName, event);

    if (!event.sourceCreated) {
      return;
    }

    this.events.emit(
      WebhookEventType.GameImported,
      webhookEnvelope({
        subjectId: event.after.gameId,
        occurrenceId: event.subjectId,
        data: {
          jobId: event.subjectId,
          batchId: event.batchId,
          gameId: event.after.gameId,
          gameTitle: event.gameTitle,
          thumbnail: event.thumbnail,
          gameCreated: event.gameCreated,
          sourceCreated: event.sourceCreated,
          platformGames: event.platformGames,
          origin: event.origin,
          isExpansion: event.isExpansion,
          baseGameIds: event.baseGameIds,
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
    //
    // Guarded against terminal states (same discipline as markCompleted and
    // onFailed): a row cancelled by its base's failure sweep must not be
    // resurrected to Running by an expansion flow that was already in flight.
    return this.db.job.updateMany({
      where: { id: jobId, status: { in: [JobStatus.Pending, JobStatus.Running] } },
      data: { status: JobStatus.Running, bullmqJobId },
    });
  }

  /**
   * Persists the durable completion summary the REST status endpoint
   * (GET /games/import/:batchId) serves — notably platformGames, since
   * collections key on PlatformGame.id rather than Game.id.
   *
   * Guarded: only a non-terminal row transitions to Completed. Returns the
   * affected-row count so the caller can skip emitting a completion for a row
   * that was already terminal (e.g. cancelled after its base failed), which
   * would otherwise resurrect it and double-fire batch completion.
   */
  private markCompleted(jobId: string, result: PersistedJobResult) {
    return this.db.job.updateMany({
      where: { id: jobId, status: { in: [JobStatus.Pending, JobStatus.Running] } },
      data: {
        status: JobStatus.Completed,
        completedAt: new Date(),
        result: result as unknown as Prisma.InputJsonValue,
        gameId: result.gameId,
      },
    });
  }
}
