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
    expansionExternalIds: ['ext-exp'],
    locale: 'en',
    userId: 'user-7',
  };

  beforeEach(() => {
    add = jest.fn().mockResolvedValue(undefined);
    create = jest.fn().mockResolvedValueOnce({ id: 'job-base' }).mockResolvedValueOnce({ id: 'job-exp' });

    const tx = { job: { create } };
    const db = { $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };

    service = new GameImportEnqueuerService(db as unknown as DatabaseService, { add } as unknown as FlowProducer);
  });

  afterEach(() => jest.clearAllMocks());

  it('stamps every flow node with the originating actor + correlation', async () => {
    await service.enqueue(baseInput);

    const flow = add.mock.calls[0][0] as FlowJob;
    const expected = { actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' };

    expect(extractJobMeta(flow.data)).toEqual(expected); // base import
    expect(extractJobMeta(flow.children?.[0]?.data)).toEqual(expected); // base fetch
    const expansion = flow.children?.[1];
    expect(extractJobMeta(expansion?.data)).toEqual(expected); // expansion import
    expect(extractJobMeta(expansion?.children?.[0]?.data)).toEqual(expected); // expansion fetch
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
