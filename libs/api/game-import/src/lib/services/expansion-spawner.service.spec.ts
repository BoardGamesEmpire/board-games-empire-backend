import type { DatabaseService } from '@bge/database';
import { InitiatorType, JobStatus, JobType } from '@bge/database';
import type { JobActorMeta } from '@bge/queue-actor-context';
import { FlowJob, FlowProducer } from 'bullmq';
import { ExpansionSpawnerService, type SpawnExpansionsInput } from './expansion-spawner.service';

describe('ExpansionSpawnerService', () => {
  let service: ExpansionSpawnerService;
  let upsert: jest.Mock;
  let transaction: jest.Mock;
  let addBulk: jest.Mock;

  const meta: JobActorMeta = { actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' };
  const input: SpawnExpansionsInput = {
    baseJobId: 'base-job',
    batchId: 'batch-1',
    correlationId: 'corr-1',
    gatewayId: 'bgg',
    baseExternalId: 'ext-base',
    expansionExternalIds: ['exp-1', 'exp-2'],
    locale: 'en',
    initiatorType: InitiatorType.User,
    userId: 'user-7',
  };

  beforeEach(() => {
    upsert = jest.fn((args) => args);
    transaction = jest.fn();
    addBulk = jest.fn().mockResolvedValue(undefined);
    const db = { job: { upsert }, $transaction: transaction };
    service = new ExpansionSpawnerService(db as unknown as DatabaseService, { addBulk } as unknown as FlowProducer);
  });

  afterEach(() => jest.clearAllMocks());

  it('is a no-op when there are no expansions', async () => {
    await service.spawn({ ...input, expansionExternalIds: [] }, meta);

    expect(transaction).not.toHaveBeenCalled();
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('upserts one row per expansion keyed on batchId:externalId and enqueues a flow for each Pending row', async () => {
    transaction.mockResolvedValue([
      { id: 'exp-job-1', status: JobStatus.Pending },
      { id: 'exp-job-2', status: JobStatus.Pending },
    ]);

    await service.spawn(input, meta);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { idempotencyKey: 'batch-1:exp:exp-1' },
        create: expect.objectContaining({
          type: JobType.GameImport,
          status: JobStatus.Pending,
          parentJobId: 'base-job',
          idempotencyKey: 'batch-1:exp:exp-1',
          payload: expect.objectContaining({ externalId: 'exp-1', baseGameExternalId: 'ext-base' }),
        }),
        update: {},
      }),
    );

    expect(addBulk).toHaveBeenCalledTimes(1);
    const flows = addBulk.mock.calls[0][0] as FlowJob[];
    expect(flows).toHaveLength(2);
    // jobId pinned to the row id → idempotent re-add on retry.
    expect(flows[0].opts?.jobId).toBe('exp-job-1');
    expect(flows[0].children?.[0]?.name).toBe('expansion.fetch');
    expect((flows[0].data as { externalId: string }).externalId).toBe('exp-1');
    expect((flows[1].data as { externalId: string }).externalId).toBe('exp-2');
  });

  it('skips flows for rows already terminal from a prior attempt (idempotent retry)', async () => {
    transaction.mockResolvedValue([
      { id: 'exp-job-1', status: JobStatus.Completed },
      { id: 'exp-job-2', status: JobStatus.Pending },
    ]);

    await service.spawn(input, meta);

    const flows = addBulk.mock.calls[0][0] as FlowJob[];
    expect(flows).toHaveLength(1);
    expect(flows[0].opts?.jobId).toBe('exp-job-2');
  });

  it('does not enqueue at all when every row is already non-Pending', async () => {
    transaction.mockResolvedValue([
      { id: 'exp-job-1', status: JobStatus.Completed },
      { id: 'exp-job-2', status: JobStatus.Failed },
    ]);

    await service.spawn(input, meta);

    expect(addBulk).not.toHaveBeenCalled();
  });

  it('dedupes repeated expansion ids so a row and flow are created only once', async () => {
    transaction.mockResolvedValue([{ id: 'exp-job-1', status: JobStatus.Pending }]);

    await service.spawn({ ...input, expansionExternalIds: ['dup', 'dup'] }, meta);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][0]).toHaveLength(1);
    const flows = addBulk.mock.calls[0][0] as FlowJob[];
    expect(flows).toHaveLength(1);
  });
});
