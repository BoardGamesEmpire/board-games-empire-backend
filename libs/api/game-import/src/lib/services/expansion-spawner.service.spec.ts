import type { DatabaseService } from '@bge/database';
import { InitiatorType, JobStatus, JobType, Prisma } from '@bge/database';
import { extractJobMeta, type JobActorMeta } from '@bge/queue-actor-context';
import { FlowJob, FlowProducer } from 'bullmq';
import {
  ExpansionSpawnerService,
  type SpawnBaseGameInput,
  type SpawnExpansionsInput,
} from './expansion-spawner.service';

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
    requestedExternalId: 'ext-base',
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
          payload: expect.objectContaining({ externalId: 'exp-1', requestedExternalId: 'ext-base' }),
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

  it("marks each chosen expansion's job row and flow as ChosenExpansion (#971)", async () => {
    transaction.mockResolvedValue([
      { id: 'exp-job-1', status: JobStatus.Pending },
      { id: 'exp-job-2', status: JobStatus.Pending },
    ]);

    await service.spawn(input, meta);

    for (const [args] of upsert.mock.calls) {
      expect(args.create.payload).toEqual(expect.objectContaining({ origin: 'ChosenExpansion' }));
    }
    const flows = addBulk.mock.calls[0][0] as FlowJob[];
    for (const flow of flows) {
      expect((flow.data as { origin?: string }).origin).toBe('ChosenExpansion');
      expect((flow.children?.[0]?.data as { origin?: string }).origin).toBe('ChosenExpansion');
    }
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

/**
 * #971: a game whose DataGateway names base games, none of them in the game
 * catalog, adds the first one to its import batch.
 */
describe('ExpansionSpawnerService.spawnBaseGame', () => {
  let service: ExpansionSpawnerService;
  let upsert: jest.Mock;
  let findUnique: jest.Mock;
  let findFirst: jest.Mock;
  let add: jest.Mock;

  const meta: JobActorMeta = { actor: { kind: 'user', userId: 'user-7' }, correlationId: 'corr-1' };
  const input: SpawnBaseGameInput = {
    parentJobId: 'exp-job-1',
    batchId: 'batch-1',
    correlationId: 'corr-1',
    gatewayId: 'bgg',
    externalId: '13',
    locale: 'en',
    initiatorType: InitiatorType.User,
    userId: 'user-7',
  };

  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

  beforeEach(() => {
    upsert = jest.fn().mockResolvedValue({ id: 'base-job-13', status: JobStatus.Pending });
    findUnique = jest.fn();
    findFirst = jest.fn().mockResolvedValue(null);
    add = jest.fn().mockResolvedValue(undefined);
    const db = { job: { upsert, findUnique, findFirst } };
    service = new ExpansionSpawnerService(
      db as unknown as DatabaseService,
      { add, addBulk: jest.fn() } as unknown as FlowProducer,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('adds one base game row and flow under the job that needed it', async () => {
    await service.spawnBaseGame(input, meta);

    expect(upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: 'batch-1:added-base:13' },
      create: {
        type: JobType.GameImport,
        status: JobStatus.Pending,
        initiatorType: InitiatorType.User,
        userId: 'user-7',
        batchId: 'batch-1',
        parentJobId: 'exp-job-1',
        idempotencyKey: 'batch-1:added-base:13',
        payload: { correlationId: 'corr-1', gatewayId: 'bgg', externalId: '13', origin: 'AddedBaseGame' },
      },
      update: {},
      select: { id: true, status: true },
    });

    expect(add).toHaveBeenCalledTimes(1);
    const flow = add.mock.calls[0][0] as FlowJob;
    expect(flow.name).toBe('game.import');
    expect(flow.opts?.jobId).toBe('base-job-13');
    expect(flow.children?.[0]?.name).toBe('game.fetch');
    expect(flow.data).toEqual(
      expect.objectContaining({ jobId: 'base-job-13', externalId: '13', origin: 'AddedBaseGame', locale: 'en' }),
    );
    expect(flow.data).not.toHaveProperty('expansionExternalIds');
    expect(extractJobMeta(flow.data)).toEqual(meta);
  });

  it('adds a base game once when two chosen expansions need it', async () => {
    await service.spawnBaseGame(input, meta);
    // The second expansion finds the row the first one added, already running.
    upsert.mockResolvedValueOnce({ id: 'base-job-13', status: JobStatus.Running });
    await service.spawnBaseGame({ ...input, parentJobId: 'exp-job-2' }, meta);

    expect(add).toHaveBeenCalledTimes(1);
  });

  it('adds a base game once when two chosen expansions need it at the same moment', async () => {
    upsert.mockRejectedValueOnce(uniqueViolation());
    findUnique.mockResolvedValue({ id: 'base-job-13', status: JobStatus.Running });

    await service.spawnBaseGame({ ...input, parentJobId: 'exp-job-2' }, meta);

    expect(findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'batch-1:added-base:13' },
      select: { id: true, status: true },
    });
    expect(add).not.toHaveBeenCalled();
  });

  it('adds nothing when the batch already imports the base game as its requested game or a chosen expansion', async () => {
    // An expansion chosen together with an expansion it expands (#971).
    findFirst.mockResolvedValue({ id: 'exp-job-13' });

    await service.spawnBaseGame({ ...input, parentJobId: 'exp-job-2' }, meta);

    expect(findFirst).toHaveBeenCalledWith({
      where: { idempotencyKey: { in: ['batch-1:base:13', 'batch-1:exp:13'] } },
      select: { id: true },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('rethrows a row failure that is not a unique violation', async () => {
    const boom = new Error('connection reset');
    upsert.mockRejectedValueOnce(boom);

    await expect(service.spawnBaseGame(input, meta)).rejects.toBe(boom);
  });
});
