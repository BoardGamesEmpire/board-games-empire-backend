import type { DatabaseService } from '@bge/database';
import { extractJobMeta } from '@bge/queue-actor-context';
import { FlowJob, FlowProducer } from 'bullmq';
import { GameImportEnqueuerService, type StartGameImportInput } from './game-import-enqueuer.service';

describe('GameImportEnqueuerService', () => {
  let service: GameImportEnqueuerService;
  let add: jest.Mock;
  let create: jest.Mock;

  const baseInput: StartGameImportInput = {
    correlationId: 'corr-1',
    gatewayId: 'bgg',
    externalId: 'ext-base',
    expansionExternalIds: ['ext-exp-1', 'ext-exp-2'],
    locale: 'en',
    userId: 'user-7',
  };

  beforeEach(() => {
    add = jest.fn().mockResolvedValue(undefined);
    create = jest.fn().mockResolvedValue({ id: 'job-base' });

    const db = { job: { create } };
    service = new GameImportEnqueuerService(db as unknown as DatabaseService, { add } as unknown as FlowProducer);
  });

  afterEach(() => jest.clearAllMocks());

  it('enqueues a base-only flow (base import + its fetch child) — expansions are deferred to the worker', async () => {
    const result = await service.enqueue(baseInput);

    expect(add).toHaveBeenCalledTimes(1);
    const flow = add.mock.calls[0][0] as FlowJob;
    expect(flow.name).toBe('game.import');
    expect(flow.children).toHaveLength(1); // only the base fetch — no expansion children
    expect(flow.children?.[0]?.name).toBe('game.fetch');
    // The base import node carries the spawn list the worker reads after persist.
    expect((flow.data as { expansionExternalIds?: string[] }).expansionExternalIds).toEqual(['ext-exp-1', 'ext-exp-2']);
    // expansionJobIds is empty: expansion rows are created later, by the base processor.
    expect(result).toEqual({ batchId: expect.any(String), baseJobId: 'job-base', expansionJobIds: [] });
  });

  it('creates only the base Job row, with an idempotency key and the requested-expansions snapshot', async () => {
    await service.enqueue(baseInput);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        parentJobId: null,
        batchId: expect.any(String),
        idempotencyKey: expect.stringMatching(/:ext-base$/),
        payload: expect.objectContaining({
          externalId: 'ext-base',
          expansionExternalIds: ['ext-exp-1', 'ext-exp-2'],
        }),
      }),
    );
  });

  it('stamps the base import + fetch nodes with the originating actor + correlation', async () => {
    await service.enqueue(baseInput);

    const flow = add.mock.calls[0][0] as FlowJob;
    const expected = { actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' };
    expect(extractJobMeta(flow.data)).toEqual(expected); // base import
    expect(extractJobMeta(flow.children?.[0]?.data)).toEqual(expected); // base fetch
  });

  it('falls back to a system actor when no userId is present', async () => {
    await service.enqueue({ ...baseInput, userId: null });

    const flow = add.mock.calls[0][0] as FlowJob;
    expect(extractJobMeta(flow.data)).toEqual({
      actor: { kind: 'system', reason: 'game-import' },
      correlationId: 'corr-1',
    });
  });
});
