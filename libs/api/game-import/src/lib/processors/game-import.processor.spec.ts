import { ContentFormat, DatabaseService, InitiatorType, JobStatus, ResourceType } from '@bge/database';
import { wrapJobData, type JobActorMeta } from '@bge/queue-actor-context';
import { WebhookEventType } from '@bge/webhooks';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { JobNames } from '../constants/queue.constants';
import { ImportJobCompletedEvent, ImportJobFailedEvent } from '../events/import.events';
import { ImportJobOrigin, type GameImportJobPayload, type ImportJobResult } from '../interfaces/import-job.interface';
import { ImportBatchCompletionService } from '../services/batch-completion.service';
import { ExpansionSpawnerService } from '../services/expansion-spawner.service';
import { GameUpsertService } from '../services/game.service';
import { extractGameDataFromChildren } from '../utils/extract-game-data';
import { GameImportProcessor } from './game-import.processor';

jest.mock('../utils/extract-game-data');
const extractMock = extractGameDataFromChildren as jest.MockedFunction<typeof extractGameDataFromChildren>;

describe('GameImportProcessor', () => {
  let processor: GameImportProcessor;
  let db: { job: { update: jest.Mock; updateMany: jest.Mock }; dataGateway: { findUnique: jest.Mock } };
  let gameUpsert: jest.Mocked<Pick<GameUpsertService, 'upsert'>>;
  let events: { emit: jest.Mock };
  let batchCompletion: { checkAndEmit: jest.Mock };
  let expansionSpawner: { spawn: jest.Mock; spawnBaseGame: jest.Mock };
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
    origin: ImportJobOrigin.Requested,
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
      dataGateway: { findUnique: jest.fn().mockResolvedValue({ contentFormat: ContentFormat.PlainText }) },
    };
    gameUpsert = { upsert: jest.fn() };
    events = { emit: jest.fn() };
    batchCompletion = { checkAndEmit: jest.fn().mockResolvedValue(undefined) };
    expansionSpawner = {
      spawn: jest.fn().mockResolvedValue(undefined),
      spawnBaseGame: jest.fn().mockResolvedValue(undefined),
    };
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
    const result: ImportJobResult = {
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames,
      baseGameIds: [],
      isExpansion: false,
    };
    gameUpsert.upsert.mockResolvedValue(result);

    const returned = await processor.process(makeJob(JobNames.GameImport, basePayload));

    expect(runWith).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'queue', actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' }),
      expect.any(Function),
    );
    expect(gameUpsert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'ext-1' }),
      'bgg',
      ContentFormat.PlainText,
      undefined,
    );

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
      origin: 'Requested',
      isExpansion: false,
      baseGameIds: [],
      gameTitle: 'Catan',
      platformGames,
    });
    // The acting user rides CLS, never the payload.
    expect(completed).not.toHaveProperty('userId');
    expect(returned).toBe(result);
  });

  describe('content format', () => {
    const imported: ImportJobResult = {
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      baseGameIds: [],
      isExpansion: false,
    };

    it("imports a game with its DataGateway's content format, read once for the job", async () => {
      db.dataGateway.findUnique.mockResolvedValue({ contentFormat: ContentFormat.Html });
      gameUpsert.upsert.mockResolvedValue(imported);

      await processor.process(makeJob(JobNames.GameImport, basePayload));

      expect(db.dataGateway.findUnique).toHaveBeenCalledTimes(1);
      expect(db.dataGateway.findUnique).toHaveBeenCalledWith({ where: { id: 'bgg' }, select: { contentFormat: true } });
      expect(gameUpsert.upsert).toHaveBeenCalledWith(expect.anything(), 'bgg', ContentFormat.Html, undefined);
    });

    it("imports an expansion with its DataGateway's content format", async () => {
      db.dataGateway.findUnique.mockResolvedValue({ contentFormat: ContentFormat.BBCode });
      gameUpsert.upsert.mockResolvedValue({ ...imported, baseGameIds: ['game-base'], isExpansion: true });

      await processor.process(
        makeJob(JobNames.ExpansionImport, {
          ...basePayload,
          origin: ImportJobOrigin.ChosenExpansion,
          requestedExternalId: 'base-1',
        }),
      );

      expect(gameUpsert.upsert).toHaveBeenCalledWith(expect.anything(), 'bgg', ContentFormat.BBCode, 'base-1');
    });

    it.each([
      ['declared none', { contentFormat: null }],
      ['is gone', null],
    ])('imports with no content format when the DataGateway %s', async (_, row) => {
      db.dataGateway.findUnique.mockResolvedValue(row);
      gameUpsert.upsert.mockResolvedValue(imported);

      await processor.process(makeJob(JobNames.GameImport, basePayload));

      expect(gameUpsert.upsert).toHaveBeenCalledWith(expect.anything(), 'bgg', null, undefined);
    });
  });

  it('spawns expansion flows after persisting a base that requested them, before marking it Completed', async () => {
    const withExpansions: GameImportJobPayload = {
      ...basePayload,
      expansionExternalIds: ['exp-a', 'exp-b'],
      locale: 'en',
    };
    gameUpsert.upsert.mockResolvedValue({
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      baseGameIds: [],
      isExpansion: false,
    });

    await processor.process(makeJob(JobNames.GameImport, withExpansions));

    expect(expansionSpawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseJobId: 'job-1',
        batchId: 'batch-1',
        gatewayId: 'bgg',
        requestedExternalId: 'ext-1',
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
    gameUpsert.upsert.mockResolvedValue({
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      baseGameIds: [],
      isExpansion: false,
    });

    await processor.process(makeJob(JobNames.GameImport, basePayload));

    expect(expansionSpawner.spawn).not.toHaveBeenCalled();
  });

  it('skips completion events when the row is already terminal (guarded markCompleted no-ops)', async () => {
    gameUpsert.upsert.mockResolvedValue({
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      baseGameIds: [],
      isExpansion: false,
    });
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
    gameUpsert.upsert.mockResolvedValue({
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames,
      baseGameIds: [],
      isExpansion: false,
    });

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
    gameUpsert.upsert.mockResolvedValue({
      gameId: 'game-1',
      gameCreated: false,
      sourceCreated: false,
      platformGames: [],
      baseGameIds: [],
      isExpansion: false,
    });

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
      baseGameIds: [],
      isExpansion: false,
    });

    await processor.process(makeJob(JobNames.GameImport, basePayload));

    const runningCall = db.job.updateMany.mock.calls.find(([arg]) => arg?.data?.status === JobStatus.Running);
    expect(runningCall).toBeDefined();
    expect(runningCall![0].data).toEqual({ status: JobStatus.Running, bullmqJobId: '1' });
    expect(runningCall![0].data).not.toHaveProperty('startedAt');
  });

  // #971: why a job is in its batch is its origin; whether its game is an
  // expansion is the link step's answer, from its content type and links.
  describe('origin and base game links', () => {
    const linkedTo = (baseGameIds: string[], isExpansion = baseGameIds.length > 0): ImportJobResult => ({
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      baseGameIds,
      isExpansion,
    });

    const completedEvent = () =>
      events.emit.mock.calls.find(
        ([name]) => name === ImportJobCompletedEvent.eventName,
      )?.[1] as ImportJobCompletedEvent;

    it('reports a requested game linked to a base game as an expansion', async () => {
      gameUpsert.upsert.mockResolvedValue(linkedTo(['g-13']));

      await processor.process(makeJob(JobNames.GameImport, basePayload));

      expect(completedEvent()).toMatchObject({ origin: 'Requested', isExpansion: true, baseGameIds: ['g-13'] });
      expect(events.emit).toHaveBeenCalledWith(
        WebhookEventType.GameImported,
        expect.objectContaining({
          data: expect.objectContaining({ origin: 'Requested', isExpansion: true, baseGameIds: ['g-13'] }),
        }),
      );
    });

    it('reports a game linked to its original but not an add-on, a remaster say, as not an expansion', async () => {
      gameUpsert.upsert.mockResolvedValue(linkedTo(['g-13'], false));

      await processor.process(makeJob(JobNames.GameImport, basePayload));

      expect(completedEvent()).toMatchObject({ origin: 'Requested', isExpansion: false, baseGameIds: ['g-13'] });
    });

    it('reports a chosen expansion linked to no base game as not an expansion', async () => {
      gameUpsert.upsert.mockResolvedValue(linkedTo([]));

      await processor.process(
        makeJob(JobNames.ExpansionImport, {
          ...basePayload,
          origin: ImportJobOrigin.ChosenExpansion,
          requestedExternalId: 'ext-base',
        }),
      );

      expect(completedEvent()).toMatchObject({ origin: 'ChosenExpansion', isExpansion: false, baseGameIds: [] });
    });

    it('passes the requested game as the fallback base game for a chosen expansion only', async () => {
      gameUpsert.upsert.mockResolvedValue(linkedTo([]));

      await processor.process(
        makeJob(JobNames.ExpansionImport, {
          ...basePayload,
          origin: ImportJobOrigin.ChosenExpansion,
          requestedExternalId: 'ext-base',
        }),
      );
      await processor.process(
        makeJob(JobNames.GameImport, {
          ...basePayload,
          origin: ImportJobOrigin.AddedBaseGame,
          requestedExternalId: 'x',
        }),
      );

      expect(gameUpsert.upsert.mock.calls.map((call) => call[3])).toEqual(['ext-base', undefined]);
    });

    it('carries the origin on the failed event and webhook, with no isExpansion', async () => {
      await processor.onFailed(
        makeJob(
          JobNames.GameImport,
          { ...basePayload, origin: ImportJobOrigin.AddedBaseGame },
          { attemptsMade: 3, attempts: 3 },
        ),
        new Error('boom'),
      );

      const failed = events.emit.mock.calls.find(([name]) => name === ImportJobFailedEvent.eventName)?.[1];
      expect(failed).toMatchObject({ origin: 'AddedBaseGame' });
      expect(failed).not.toHaveProperty('isExpansion');
      expect(events.emit).toHaveBeenCalledWith(
        WebhookEventType.ImportJobFailed,
        expect.objectContaining({ data: expect.not.objectContaining({ isExpansion: expect.anything() }) }),
      );
    });
  });

  // #971: an expansion, DLC or mod whose base game is not in the game catalog
  // adds it to its import batch.
  describe('adding a base game', () => {
    const needsBaseGame: ImportJobResult = {
      gameId: 'game-1',
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      baseGameIds: [],
      baseGameToAdd: '13',
      isExpansion: true,
    };

    beforeEach(() => gameUpsert.upsert.mockResolvedValue(needsBaseGame));

    it('reports an expansion whose base game it adds as an expansion, linked to none yet', async () => {
      await processor.process(makeJob(JobNames.GameImport, basePayload));

      expect(events.emit.mock.calls.find(([name]) => name === ImportJobCompletedEvent.eventName)?.[1]).toMatchObject({
        isExpansion: true,
        baseGameIds: [],
      });
    });

    it('adds the base game a requested expansion needs before marking it Completed', async () => {
      await processor.process(makeJob(JobNames.GameImport, { ...basePayload, locale: 'en' }));

      expect(expansionSpawner.spawnBaseGame).toHaveBeenCalledWith(
        {
          parentJobId: 'job-1',
          batchId: 'batch-1',
          correlationId: 'corr-1',
          gatewayId: 'bgg',
          externalId: '13',
          locale: 'en',
          initiatorType: InitiatorType.User,
          userId: 'user-7',
        },
        meta,
      );
      // The added row must be visible to batch completion before this job's
      // Completed write can let the batch finish.
      const upsertOrder = gameUpsert.upsert.mock.invocationCallOrder[0];
      const spawnOrder = expansionSpawner.spawnBaseGame.mock.invocationCallOrder[0];
      const completedIdx = db.job.updateMany.mock.calls.findIndex(([arg]) => arg?.data?.status === JobStatus.Completed);
      expect(upsertOrder).toBeLessThan(spawnOrder);
      expect(spawnOrder).toBeLessThan(db.job.updateMany.mock.invocationCallOrder[completedIdx]);
    });

    it.each([ImportJobOrigin.Requested, ImportJobOrigin.ChosenExpansion])(
      'adds the base game a %s job needs',
      async (origin) => {
        await processor.process(
          makeJob(JobNames.ExpansionImport, { ...basePayload, origin, requestedExternalId: 'ext-requested' }),
        );

        expect(expansionSpawner.spawnBaseGame).toHaveBeenCalledWith(
          expect.objectContaining({ parentJobId: 'job-1', externalId: '13' }),
          meta,
        );
      },
    );

    it('never adds a base game for an added base game', async () => {
      await processor.process(makeJob(JobNames.GameImport, { ...basePayload, origin: ImportJobOrigin.AddedBaseGame }));

      expect(expansionSpawner.spawnBaseGame).not.toHaveBeenCalled();
    });

    it('adds nothing for a game that needs no base game', async () => {
      gameUpsert.upsert.mockResolvedValue({ ...needsBaseGame, baseGameToAdd: undefined });

      await processor.process(makeJob(JobNames.GameImport, basePayload));

      expect(expansionSpawner.spawnBaseGame).not.toHaveBeenCalled();
    });
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
        expect.objectContaining({
          source: 'queue',
          actor: { kind: 'user', userId: 'user-7' },
          correlationId: 'corr-1',
        }),
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
      expect(failed.origin).toBe(ImportJobOrigin.Requested);
      expect(failed).not.toHaveProperty('userId');
      expect(batchCompletion.checkAndEmit).toHaveBeenCalledWith('batch-1');
    });

    it('cancels still-Pending children when the requested game fails permanently', async () => {
      await processor.onFailed(
        makeJob(JobNames.GameImport, basePayload, { attemptsMade: 3, attempts: 3 }),
        new Error('boom'),
      );

      expect(db.job.updateMany).toHaveBeenCalledWith({
        where: { parentJobId: 'job-1', status: JobStatus.Pending },
        data: {
          status: JobStatus.Cancelled,
          result: {
            errorCode: 'BASE_IMPORT_FAILED',
            error: 'Skipped because the import that added it to the batch failed.',
          },
        },
      });
    });

    // #971: a chosen expansion adds its base game as a child, so its failure
    // leaves the same orphans a requested game's would.
    it('cancels still-Pending children of any import job that fails, since a chosen expansion can add a base game', async () => {
      await processor.onFailed(
        makeJob(
          JobNames.ExpansionImport,
          { ...basePayload, jobId: 'exp-job', origin: ImportJobOrigin.ChosenExpansion, requestedExternalId: 'ext-1' },
          { attemptsMade: 3, attempts: 3 },
        ),
        new Error('boom'),
      );

      expect(db.job.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { parentJobId: 'exp-job', status: JobStatus.Pending } }),
      );
    });

    it('leaves the requested game Completed when its added base game fails', async () => {
      await processor.onFailed(
        makeJob(
          JobNames.GameImport,
          { ...basePayload, jobId: 'added-base-job', origin: ImportJobOrigin.AddedBaseGame },
          { attemptsMade: 3, attempts: 3 },
        ),
        new Error('boom'),
      );

      // Only the added base game's own row, and its own (absent) children, are
      // written; the game that needed it keeps its Completed status, and the
      // batch ends PartiallyCompleted rather than cancelled.
      const wheres = db.job.updateMany.mock.calls.map(([args]) => args.where);
      expect(wheres).toEqual([
        { id: 'added-base-job', status: { in: [JobStatus.Pending, JobStatus.Running] } },
        { parentJobId: 'added-base-job', status: JobStatus.Pending },
      ]);
      expect(batchCompletion.checkAndEmit).toHaveBeenCalledWith('batch-1');
    });

    it(
      'sanitizes the webhook payload and the persisted result — no raw error text reaches ' +
        'third-party subscribers or the non-owner-scoped REST status endpoint',
      async () => {
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
      },
    );

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
