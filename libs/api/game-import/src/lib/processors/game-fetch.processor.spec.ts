import { DatabaseService, InitiatorType, JobStatus } from '@bge/database';
import { GatewayRegistryService } from '@bge/gateway-registry';
import { wrapJobData, type JobActorMeta } from '@bge/queue-actor-context';
import { WebhookEventType } from '@bge/webhooks';
import * as proto from '@boardgamesempire/proto-gateway';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { of } from 'rxjs';
import { ImportEvents, JobNames } from '../constants/queue.constants';
import type { GameFetchJobPayload } from '../interfaces/import-job.interface';
import { ImportBatchCompletionService } from '../services/batch-completion.service';
import { GameFetchProcessor } from './game-fetch.processor';

describe('GameFetchProcessor', () => {
  let processor: GameFetchProcessor;
  let db: { job: { updateMany: jest.Mock; update: jest.Mock; findFirst: jest.Mock } };
  let gatewayRegistry: jest.Mocked<
    Pick<GatewayRegistryService, 'getServiceClient' | 'reportSuccess' | 'reportFailure'>
  >;
  let events: { emit: jest.Mock };
  let batchCompletion: { checkAndEmit: jest.Mock };
  let runWith: jest.Mock;
  let fetchGame: jest.Mock;

  const payload: GameFetchJobPayload = {
    jobId: 'job-1',
    batchId: 'batch-1',
    correlationId: 'corr-1',
    gatewayId: 'bgg',
    externalId: 'ext-1',
    initiatorType: InitiatorType.User,
    userId: 'user-7',
    locale: 'en',
  };
  const meta: JobActorMeta = { actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' };

  const makeJob = (over: { attemptsMade?: number; attempts?: number } = {}): Job<GameFetchJobPayload> =>
    ({
      name: 'GameFetch',
      id: '1',
      queueName: 'gateway-fetch',
      data: wrapJobData(payload, meta),
      attemptsMade: over.attemptsMade ?? 0,
      opts: { attempts: over.attempts ?? 5 },
    }) as unknown as Job<GameFetchJobPayload>;

  beforeEach(() => {
    db = {
      job: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(undefined),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    fetchGame = jest.fn();
    gatewayRegistry = {
      getServiceClient: jest.fn().mockResolvedValue({ fetchGame }),
      reportSuccess: jest.fn(),
      reportFailure: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };
    batchCompletion = { checkAndEmit: jest.fn().mockResolvedValue(undefined) };
    runWith = jest.fn((_init: unknown, fn: () => unknown) => fn());

    processor = new GameFetchProcessor(
      db as unknown as DatabaseService,
      gatewayRegistry as unknown as GatewayRegistryService,
      events as unknown as EventEmitter2,
      batchCompletion as unknown as ImportBatchCompletionService,
    );
    // ActorAwareWorkerHost injects auditContext as a property; set it directly.
    (processor as unknown as { auditContext: { runWith: typeof runWith } }).auditContext = { runWith };
  });

  afterEach(() => jest.clearAllMocks());

  describe('process', () => {
    it('opens a CLS scope with the job actor, fetches, reports success, and returns the game', async () => {
      const game = { title: 'Catan', externalId: 'ext-1' } as proto.GameData;
      fetchGame.mockReturnValue(of({ game }));

      const result = await processor.process(makeJob());

      expect(runWith).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'queue',
          actor: { kind: 'user', userId: 'user-7' },
          correlationId: 'corr-1',
        }),
        expect.any(Function),
      );
      expect(db.job.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'job-1', status: JobStatus.Pending } }),
      );
      expect(fetchGame).toHaveBeenCalledWith({ correlationId: 'corr-1', externalId: 'ext-1', locale: 'en' });
      expect(gatewayRegistry.reportSuccess).toHaveBeenCalledWith('bgg');
      expect(result).toBe(game);
    });

    it('emits JobStarted exactly on the Pending → Running transition', async () => {
      fetchGame.mockReturnValue(of({ game: { title: 'Catan' } as proto.GameData }));

      await processor.process(makeJob());
      expect(events.emit).toHaveBeenCalledWith(
        ImportEvents.JobStarted,
        expect.objectContaining({ jobId: 'job-1', batchId: 'batch-1', isExpansion: false, userId: 'user-7' }),
      );

      // Retry attempt: the row is already Running, so no started events fire.
      events.emit.mockClear();
      db.job.updateMany.mockResolvedValue({ count: 0 });
      await processor.process(makeJob({ attemptsMade: 1 }));
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('throws NotFound and reports failure when the gateway returns no game', async () => {
      fetchGame.mockReturnValue(of({ game: undefined, message: 'nope' }));

      await expect(processor.process(makeJob())).rejects.toBeInstanceOf(NotFoundException);
      expect(gatewayRegistry.reportFailure).toHaveBeenCalledWith('bgg', expect.any(NotFoundException));
      expect(gatewayRegistry.reportSuccess).not.toHaveBeenCalled();
    });

    it('rejects a job missing the __meta envelope (no fallback actor)', async () => {
      const unwrapped = {
        name: 'GameFetch',
        id: '2',
        queueName: 'gateway-fetch',
        data: payload,
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as unknown as Job<GameFetchJobPayload>;

      await expect(processor.process(unwrapped)).rejects.toThrow(/__meta/);
      expect(runWith).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('does not fail the Job row while retries remain', async () => {
      await processor.onFailed(makeJob({ attemptsMade: 2, attempts: 5 }), new Error('boom'));
      expect(db.job.update).not.toHaveBeenCalled();
      expect(runWith).not.toHaveBeenCalled();
    });

    it('marks the Job row Failed once attempts are exhausted, inside the actor scope', async () => {
      await processor.onFailed(makeJob({ attemptsMade: 5, attempts: 5 }), new Error('gateway down'));
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
          error: 'gateway down',
          result: { errorCode: 'GATEWAY_ERROR', error: 'Fetching game data from the gateway failed.' },
        },
      });
      expect(events.emit).toHaveBeenCalledWith(
        ImportEvents.JobFailed,
        expect.objectContaining({
          jobId: 'job-1',
          errorCode: 'GATEWAY_ERROR',
          error: 'Fetching game data from the gateway failed.',
          isExpansion: false,
        }),
      );
      expect(batchCompletion.checkAndEmit).toHaveBeenCalledWith('batch-1');
    });

    it('backfills only the raw error column — never result — without re-emitting when the import-side cascade won the race', async () => {
      // First updateMany (guarded transition) loses; second is the error backfill.
      db.job.updateMany.mockResolvedValueOnce({ count: 0 });

      await processor.onFailed(makeJob({ attemptsMade: 5, attempts: 5 }), new Error('gateway down'));

      expect(db.job.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'job-1', status: JobStatus.Failed },
        data: { error: 'gateway down' },
      });
      // result must NOT be rewritten: the winning process already persisted its
      // classification and emitted the webhook/notification off it. Overwriting
      // result here would desync the REST status endpoint from those payloads.
      expect(db.job.updateMany.mock.calls.at(-1)![0].data).not.toHaveProperty('result');
      expect(events.emit).not.toHaveBeenCalled();
      expect(batchCompletion.checkAndEmit).not.toHaveBeenCalled();
    });

    it('flags expansion fetches as expansions in the failure event', async () => {
      const expansionJob = {
        name: JobNames.ExpansionFetch,
        id: '9',
        queueName: 'gateway-fetch',
        data: wrapJobData({ ...payload, jobId: 'exp-job', baseGameExternalId: 'base-ext' }, meta),
        attemptsMade: 5,
        opts: { attempts: 5 },
      } as unknown as Job<GameFetchJobPayload>;

      await processor.onFailed(expansionJob, new Error('gateway down'));

      expect(events.emit).toHaveBeenCalledWith(
        ImportEvents.JobFailed,
        expect.objectContaining({ jobId: 'exp-job', isExpansion: true }),
      );
      expect(batchCompletion.checkAndEmit).toHaveBeenCalledWith('batch-1');
    });

    it('sanitizes the webhook payload — raw gateway/transport error text never reaches subscribers', async () => {
      await processor.onFailed(
        makeJob({ attemptsMade: 5, attempts: 5 }),
        new Error('14 UNAVAILABLE: Name resolution failed for target dns:internal-gateway.svc.cluster.local:50051'),
      );

      expect(events.emit).toHaveBeenCalledWith(
        WebhookEventType.ImportJobFailed,
        expect.objectContaining({
          data: expect.objectContaining({
            errorCode: 'GATEWAY_ERROR',
            error: 'Fetching game data from the gateway failed.',
          }),
        }),
      );
    });
  });
});
