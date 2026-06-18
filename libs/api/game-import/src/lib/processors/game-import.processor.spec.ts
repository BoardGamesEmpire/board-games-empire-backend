import { DatabaseService, InitiatorType, JobStatus } from '@bge/database';
import { wrapJobData, type JobActorMeta } from '@bge/queue-actor-context';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { ImportEvents, JobNames } from '../constants/queue.constants';
import type { GameImportJobPayload, ImportJobResult } from '../interfaces/import-job.interface';
import { GameUpsertService } from '../services/game.service';
import { extractGameDataFromChildren } from '../utils/extract-game-data';
import { GameImportProcessor } from './game-import.processor';

jest.mock('../utils/extract-game-data');
const extractMock = extractGameDataFromChildren as jest.MockedFunction<typeof extractGameDataFromChildren>;

describe('GameImportProcessor', () => {
  let processor: GameImportProcessor;
  let db: { job: { update: jest.Mock } };
  let gameUpsert: jest.Mocked<Pick<GameUpsertService, 'upsert' | 'upsertExpansion'>>;
  let events: { emit: jest.Mock };
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
    db = { job: { update: jest.fn().mockResolvedValue(undefined) } };
    gameUpsert = { upsert: jest.fn(), upsertExpansion: jest.fn() };
    events = { emit: jest.fn() };
    runWith = jest.fn((_init: unknown, fn: () => unknown) => fn());
    extractMock.mockReturnValue({ externalId: 'ext-1', title: 'Catan', thumbnailUrl: 'http://x/y.png' } as ReturnType<
      typeof extractGameDataFromChildren
    >);

    processor = new GameImportProcessor(
      db as unknown as DatabaseService,
      gameUpsert as unknown as GameUpsertService,
      events as unknown as EventEmitter2,
    );
    // ActorAwareWorkerHost injects auditContext as a property; set it directly.
    (processor as unknown as { auditContext: { runWith: typeof runWith } }).auditContext = { runWith };
  });

  afterEach(() => jest.clearAllMocks());

  it('processes a base game inside the actor scope and emits JobCompleted', async () => {
    const result: ImportJobResult = { gameId: 'game-1', gameCreated: true, sourceCreated: true };
    gameUpsert.upsert.mockResolvedValue(result);

    const returned = await processor.process(makeJob(JobNames.GameImport, basePayload));

    expect(runWith).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'queue', actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' }),
      expect.any(Function),
    );
    expect(gameUpsert.upsert).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'ext-1' }), 'bgg');
    expect(events.emit).toHaveBeenCalledWith(
      ImportEvents.JobCompleted,
      expect.objectContaining({ jobId: 'job-1', gameId: 'game-1', isExpansion: false, userId: 'user-7' }),
    );
    expect(returned).toBe(result);
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
      expect(db.job.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: JobStatus.Failed, error: 'boom' },
      });
      expect(events.emit).toHaveBeenCalledWith(
        ImportEvents.JobFailed,
        expect.objectContaining({ jobId: 'job-1', error: 'boom' }),
      );
    });

    it('only warns while retries remain', async () => {
      await processor.onFailed(
        makeJob(JobNames.GameImport, basePayload, { attemptsMade: 1, attempts: 3 }),
        new Error('temp'),
      );
      expect(db.job.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
