import { DatabaseService, InitiatorType, JobStatus, ResourceType } from '@bge/database';
import { WebhookEventType } from '@bge/webhooks';
import { wrapJobData, type JobActorMeta } from '@bge/queue-actor-context';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { JobNames } from '../constants/queue.constants';
import { ImportJobCompletedEvent, ImportJobFailedEvent } from '../events/import.events';
import type { GameImportJobPayload, ImportJobResult } from '../interfaces/import-job.interface';
import { ImportBatchCompletionService } from '../services/batch-completion.service';
import { ExpansionSpawnerService } from '../services/expansion-spawner.service';
import { GameUpsertService } from '../services/game.service';
import { extractGameDataFromChildren } from '../utils/extract-game-data';
import { GameImportProcessor } from './game-import.processor';

jest.mock('../utils/extract-game-data');
const extractMock = extractGameDataFromChildren as jest.MockedFunction<typeof extractGameDataFromChildren>;

describe('GameImportProcessor', () => {
  let processor: GameImportProcessor;
  let db: { job: { update: jest.Mock; updateMany: jest.Mock } };
  let gameUpsert: jest.Mocked<Pick<GameUpsertService, 'upsert' | 'upsertExpansion'>>;
  let events: { emit: jest.Mock };
  let batchCompletion: { checkAndEmit: jest.Mock };
  let expansionSpawner: { spawn: jest.Mock };
  let runWith: jest.Mock;

  const meta: JobActorMeta = { actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' };
  const basePayload: GameImportJobPayload = {
    jobId: 'job-1',
    batchId: 'batch-1',
    correlationId: 'corr-1',
    gatewayId: 'bgg',
    externalId: 'ext-1',
    initiatorType: InitiatorType.User,
    userId: 'user-7',
  };

  const makeJob = (name: string, payload: object, over: { attemptsMade?: number; attempts?: number } = {}): Job =>
    ({
      name,
      id: '1',
      queueName: 'games-import',
      data: wrapJobData(payload, meta),
      attemptsMade: over.attemptsMade ?? 0,
      opts: { attempts: over.attempts ?? 3 },
      getChildrenValues: jest.fn().mockResolvedValue({}),
    }) as unknown as Job;

  beforeEach(() => {
    db = {
      job: {
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    gameUpsert = { upsert: jest.fn(), upsertExpansion: jest.fn() };
    events = { emit: jest.fn() };
    batchCompletion = { checkAndEmit: jest.fn().mockResolvedValue(undefined) };
    expansionSpawner = { spawn: jest.fn().mockResolvedValue(undefined) };
    runWith = jest.fn((_init: unknown, fn: () => unknown) => fn());
    extractMock.mockReturnValue({ externalId: 'ext-1', title: 'Catan', thumbnailUrl: 'http://x/y.png' } as ReturnType<
      typeof extractGameDataFromChildren
    >);

    processor = new GameImportProcessor(
      db as unknown as DatabaseService,
      gameUpsert as unknown as GameUpsertService,
      events as unknown as EventEmitter2,
      batchCompletion as unknown as ImportBatchCompletionService,
      expansionSpawner as unknown as ExpansionSpawnerService,
    );
    // ActorAwareWorkerHost injects auditContext as a property; set it directly.
    (processor as unknown as { auditContext: { runWith: typeof runWith } }).auditContext = { runWith };
  });

  afterEach(() => jest.clearAllMocks());

  it('processes a base game inside the actor scope and emits an ImportJobCompletedEvent', async () => {
    const platformGames = [{ platformId: 'plat-1', platformGameId: 'pg-1' }];
    const result: ImportJobResult = { gameId: 'game-1', gameCreated: true, sourceCreated: true, platformGames };
    gameUpsert.upsert.mockResolvedValue(result);

    const returned = await processor.process(makeJob(JobNames.GameImport, basePayload));

    expect(runWith).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'queue', actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' }),
      expect.any(Function),
    );
    expect(gameUpsert.upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'ext-1' }), 'bgg');

    const completedCall = events.emit.mock.calls.find(([name]) => name === ImportJobCompletedEvent.eventName);
    expect(completedCall).toBeDefined();
    const completed = completedCall![1] as ImportJobCompletedEvent;
    expect(completed).toBeInstanceOf(ImportJobCompletedEvent);
    expect(completed.action).toBe('update');
    expect(completed.subject).toBe(ResourceType.Job);
    expect(completed.subjectId).toBe('job-1');
    expect(completed.before).toEqual({ id: 'job-1', status: JobStatus.Running });
    expect(completed.after).toEqual({ id: 'job-1', status: JobStatus.Completed, gameId: 'game-1' });
    expect(completed).toMatchObject({
      batchId: 'batch-1',
      gatewayId: 'bgg',
      externalId: 'ext-1',
      isExpansion: false,
      gameTitle: 'Catan',
      platformGames,
    });
    // The acting user rides CLS, never the payload.
    expect(completed).not.toHaveProperty('userId');
    expect(returned).toBe(result);
  });

  it('spawns expansion flows after persisting a base that requested them, before marking it Completed', async () => {
    const withExpansions: GameImportJobPayload = {
      ...basePayload,
      expansionExternalIds: ['exp-a', 'exp-b'],
      locale: 'en',
    };
    gameUpsert.upsert.mockResolvedValue({ gameId: 'game-1', gameCreated: true, sourceCreated: true, platformGames: [] });

    await processor.process(makeJob(JobNames.GameImport, withExpansions));

    expect(expansionSpawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseJobId: 'job-1',
        batchId: 'batch-1',
        gatewayId: 'bgg',
        baseExternalId: 'ext-1',
        expansionExternalIds: ['exp-a', 'exp-b'],
        locale: 'en',
        userId: 'user-7',
      }),
      meta,
    );

    // Ordering guarantee: expansions must be spawned (their Pending rows created)
    // before the base row flips to Completed, so batch-completion can't fire on
    // the base alone.
    const spawnOrder = expansionSpawner.spawn.mock.invocationCallOrder[0];
    const completedIdx = db.job.updateMany.mock.calls.findIndex(([arg]) => arg?.data?.status === JobStatus.Completed);
    expect(spawnOrder).toBeLessThan(db.job.updateMany.mock.invocationCallOrder[completedIdx]);
  });

  it('does not spawn when a base requested no expansions', async () => {
    gameUpsert.upsert.mockResolvedValue({ gameId: 'game-1', gameCreated: true, sourceCreated: true, platformGames: [] });

    await processor.process(makeJob(JobNames.GameImport, basePayload));

    expect(expansionSpawner.spawn).not.toHaveBeenCalled();
  });

  it('skips completion events when the row is already terminal (guarded markCompleted no-ops)', async () => {
    gameUpsert.upsert.mockResolvedValue({ gameId: 'game-1', gameCreated: true, sourceCreated: true, platformGames: [] });
    // Both markRunning and markCompleted no-op: the row was cancelled (e.g. its
    // base failed) while this flow was in flight.
    db.job.updateMany.mockResolvedValue({ count: 0 });

    await processor.process(makeJob(JobNames.GameImport, basePayload));

    expect(gameUpsert.upsert).toHaveBeenCalled(); // idempotent persist still ran
    expect(events.emit).not.toHaveBeenCalledWith(ImportJobCompletedEvent.eventName, expect.anything());
    expect(batchCompletion.checkAndEmit).not.toHaveBeenCalled();
  });

  it('persists the durable result summary (platformGames included) and checks batch completion', async () => {
    const platformGames = [{ platformId: 'plat-1', platformGameId: 'pg-1' }];
    gameUpsert.upsert.mockResolvedValue({ gameId: 'game-1', gameCreated: true, sourceCreated: true, platformGames });

    await processor.process(makeJob(JobNames.GameImport, basePayload));

    expect(db.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: { in: [JobStatus.Pending, JobStatus.Running] } },
        data: expect.objectContaining({
          status: JobStatus.Completed,
          gameId: 'game-1',
          result: expect.objectContaining({ gameId: 'game-1', gameTitle: 'Catan', platformGames }),
        }),
      }),
    );
    expect(batchCompletion.checkAndEmit).toHaveBeenCalledWith('batch-1');
  });

  it('skips the imported webhook on re-imports (no new source) but still emits JobCompleted', async () => {
    gameUpsert.upsert.mockResolvedValue({ gameId: 'game-1', gameCreated: false, sourceCreated: false, platformGames: [] });

    await processor.process(makeJob(JobNames.GameImport, basePayload));

    const completedCall = events.emit.mock.calls.find(([name]) => name === ImportJobCompletedEvent.eventName);
    expect(completedCall).toBeDefined();
    const completed = completedCall![1] as ImportJobCompletedEvent;
    expect(completed.subjectId).toBe('job-1');
    expect(completed.sourceCreated).toBe(false);
    expect(events.emit).not.toHaveBeenCalledWith(WebhookEventType.GameImported, expect.anything());
  });

  it('marks Running without re-stamping startedAt (owned by the fetch processor)', async () => {
    gameUpsert.upsert.mockResolvedValue({
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
    });

    await processor.process(makeJob(JobNames.GameImport, basePayload));

    const runningCall = db.job.updateMany.mock.calls.find(([arg]) => arg?.data?.status === JobStatus.Running);
    expect(runningCall).toBeDefined();
    expect(runningCall![0].data).toEqual({ status: JobStatus.Running, bullmqJobId: '1' });
    expect(runningCall![0].data).not.toHaveProperty('startedAt');
  });

  it('throws on an unknown job name', async () => {
    await expect(processor.process(makeJob('Nope', basePayload))).rejects.toThrow(/Unknown job name/);
  });

  it('rejects a job missing the __meta envelope (no fallback actor)', async () => {
    const unwrapped = {
      name: JobNames.GameImport,
      id: '2',
      queueName: 'games-import',
      data: basePayload,
      getChildrenValues: jest.fn(),
    } as unknown as Job;

    await expect(processor.process(unwrapped)).rejects.toThrow(/__meta/);
    expect(runWith).not.toHaveBeenCalled();
  });

  describe('onFailed', () => {
    it('marks the row Failed and emits JobFailed once attempts are exhausted', async () => {
      await processor.onFailed(
        makeJob(JobNames.GameImport, basePayload, { attemptsMade: 3, attempts: 3 }),
        new Error('boom'),
      );
      expect(runWith).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'queue', actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' }),
        expect.any(Function),
      );
      expect(db.job.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-1', status: { in: [JobStatus.Pending, JobStatus.Running] } },
        data: {
          status: JobStatus.Failed,
          error: 'boom',
          result: { errorCode: 'INTERNAL_ERROR', error: 'The import failed due to an internal error.' },
        },
      });

      const failedCall = events.emit.mock.calls.find(([name]) => name === ImportJobFailedEvent.eventName);
      expect(failedCall).toBeDefined();
      const failed = failedCall![1] as ImportJobFailedEvent;
      expect(failed).toBeInstanceOf(ImportJobFailedEvent);
      expect(failed.action).toBe('update');
      expect(failed.subject).toBe(ResourceType.Job);
      expect(failed.subjectId).toBe('job-1');
      expect(failed.before).toEqual({ id: 'job-1' }); // prior status unknown at the shared emit point — identity only
      // after carries the sanitized classification persisted to Job.result.
      expect(failed.after).toEqual({
        id: 'job-1',
        status: JobStatus.Failed,
        result: { errorCode: 'INTERNAL_ERROR', error: 'The import failed due to an internal error.' },
      });
      expect(failed.isExpansion).toBe(false);
      expect(failed).not.toHaveProperty('userId');
      expect(batchCompletion.checkAndEmit).toHaveBeenCalledWith('batch-1');
    });

    it('cancels still-Pending expansion children when a base import fails permanently', async () => {
      await processor.onFailed(
        makeJob(JobNames.GameImport, basePayload, { attemptsMade: 3, attempts: 3 }),
        new Error('boom'),
      );

      expect(db.job.updateMany).toHaveBeenCalledWith({
        where: { parentJobId: 'job-1', status: JobStatus.Pending },
        data: {
          status: JobStatus.Cancelled,
          result: { errorCode: 'BASE_IMPORT_FAILED', error: 'Skipped because the base game import failed.' },
        },
      });
    });

    it('does not run the child-cancellation sweep when an expansion import fails', async () => {
      await processor.onFailed(
        makeJob(JobNames.ExpansionImport, { ...basePayload, baseGameExternalId: 'ext-base' }, { attemptsMade: 3, attempts: 3 }),
        new Error('boom'),
      );

      expect(db.job.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ parentJobId: expect.anything() }) }),
      );
    });

    it('sanitizes the webhook payload and the persisted result — no raw error text reaches ' +
      'third-party subscribers or the non-owner-scoped REST status endpoint', async () => {
      await processor.onFailed(
        makeJob(JobNames.GameImport, basePayload, { attemptsMade: 3, attempts: 3 }),
        new Error('ECONNREFUSED 10.0.4.12:5432 (internal db host leaked in a raw Prisma error)'),
      );

      expect(events.emit).toHaveBeenCalledWith(
        WebhookEventType.ImportJobFailed,
        expect.objectContaining({
          data: expect.objectContaining({
            jobId: 'job-1',
            errorCode: 'INTERNAL_ERROR',
            error: 'The import failed due to an internal error.',
          }),
        }),
      );
      expect(db.job.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            result: { errorCode: 'INTERNAL_ERROR', error: 'The import failed due to an internal error.' },
          }),
        }),
      );
      // The in-process event (consumed by the owner-facing notification
      // listener and the audit listener) also carries only the sanitized
      // classification — the raw message with the internal host never reaches
      // it; it lives solely in the Job.error column and operator logs.
      const failedCall = events.emit.mock.calls.find(([name]) => name === ImportJobFailedEvent.eventName);
      const failed = failedCall![1] as ImportJobFailedEvent;
      expect(failed.after.result).toEqual({
        errorCode: 'INTERNAL_ERROR',
        error: 'The import failed due to an internal error.',
      });
      expect(JSON.stringify(failed)).not.toContain('10.0.4.12');
    });

    it('skips events when the row is already terminal (fetch side marked it first)', async () => {
      db.job.updateMany.mockResolvedValue({ count: 0 });

      await processor.onFailed(
        makeJob(JobNames.GameImport, basePayload, { attemptsMade: 3, attempts: 3 }),
        new Error('child job failed'),
      );

      expect(events.emit).not.toHaveBeenCalled();
      expect(batchCompletion.checkAndEmit).not.toHaveBeenCalled();
    });

    it('only warns while retries remain', async () => {
      await processor.onFailed(
        makeJob(JobNames.GameImport, basePayload, { attemptsMade: 1, attempts: 3 }),
        new Error('temp'),
      );
      expect(db.job.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(runWith).not.toHaveBeenCalled();
    });
  });
});
