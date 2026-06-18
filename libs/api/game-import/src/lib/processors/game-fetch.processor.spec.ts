import { DatabaseService, InitiatorType, JobStatus } from '@bge/database';
import { GatewayRegistryService } from '@bge/gateway-registry';
import { wrapJobData, type JobActorMeta } from '@bge/queue-actor-context';
import * as proto from '@board-games-empire/proto-gateway';
import { NotFoundException } from '@nestjs/common';
import { Job } from 'bullmq';
import { of } from 'rxjs';
import type { GameFetchJobPayload } from '../interfaces/import-job.interface';
import { GameFetchProcessor } from './game-fetch.processor';

describe('GameFetchProcessor', () => {
  let processor: GameFetchProcessor;
  let db: { job: { updateMany: jest.Mock; update: jest.Mock } };
  let gatewayRegistry: jest.Mocked<
    Pick<GatewayRegistryService, 'getServiceClient' | 'reportSuccess' | 'reportFailure'>
  >;
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
      job: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue(undefined) },
    };
    fetchGame = jest.fn();
    gatewayRegistry = {
      getServiceClient: jest.fn().mockResolvedValue({ fetchGame }),
      reportSuccess: jest.fn(),
      reportFailure: jest.fn().mockResolvedValue(undefined),
    };
    runWith = jest.fn((_init: unknown, fn: () => unknown) => fn());

    processor = new GameFetchProcessor(
      db as unknown as DatabaseService,
      gatewayRegistry as unknown as GatewayRegistryService,
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
        expect.objectContaining({ source: 'queue', actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' }),
        expect.any(Function),
      );
      expect(db.job.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { status: JobStatus.Failed, error: 'gateway down' },
      });
    });
  });
});
