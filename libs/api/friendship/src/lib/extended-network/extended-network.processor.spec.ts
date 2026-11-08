import type { JobMetaEnvelope } from '@bge/queue-actor-context';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { type ExtendedNetworkJob, ExtendedNetworkJobNames } from './extended-network-queue.constants';
import { ExtendedNetworkProcessor } from './extended-network.processor';
import type { ExtendedNetworkService } from './extended-network.service';

type JobData = ExtendedNetworkJob & JobMetaEnvelope;

describe('ExtendedNetworkProcessor (#497)', () => {
  const result = { removed: 1, written: 2 };
  const extendedNetwork = {
    rebuildAround: jest.fn().mockResolvedValue(result),
    rebuildAllBatch: jest.fn(),
  } satisfies Partial<jest.Mocked<ExtendedNetworkService>>;
  const processor = new ExtendedNetworkProcessor(extendedNetwork as unknown as ExtendedNetworkService);

  const meta = { actor: { kind: 'system', reason: 'extended-network-rebuild' }, correlationId: 'c-1' };
  let job: { updateData: jest.Mock; moveToDelayed: jest.Mock };

  const run = (name: string, data: ExtendedNetworkJob) =>
    (processor as unknown as { processJob: (job: Job<JobData>, token?: string) => Promise<unknown> }).processJob(
      {
        name,
        data: data as JobData,
        queueName: '{bge.friendship.extended-network}',
        id: '7',
        ...job,
      } as unknown as Job<JobData>,
      'token-1',
    );

  beforeEach(() => {
    jest.clearAllMocks();
    job = { updateData: jest.fn().mockResolvedValue(undefined), moveToDelayed: jest.fn().mockResolvedValue(undefined) };
  });

  it("rebuilds around the job's user (#497)", async () => {
    await expect(run(ExtendedNetworkJobNames.RebuildAround, { userId: 'user-1' })).resolves.toEqual(result);

    expect(extendedNetwork.rebuildAround).toHaveBeenCalledWith('user-1');
    expect(extendedNetwork.rebuildAllBatch).not.toHaveBeenCalled();
  });

  // One batch per run of the job, so a change's job runs between two
  // batches. The progress goes into the job before it moves, so a worker lost
  // between the two runs the next batch, not this one again.
  it('runs the first batch of a full rebuild, saves where it got to, and goes back to the queue (#497)', async () => {
    const order: string[] = [];
    extendedNetwork.rebuildAllBatch.mockResolvedValue({ removed: 1, written: 2, next: 'user-200' });
    job.updateData.mockImplementation(async () => order.push('save'));
    job.moveToDelayed.mockImplementation(async () => order.push('delay'));

    await expect(run(ExtendedNetworkJobNames.RebuildAll, meta as never)).rejects.toBeInstanceOf(DelayedError);

    expect(extendedNetwork.rebuildAllBatch).toHaveBeenCalledWith(null);
    expect(job.updateData).toHaveBeenCalledWith({ ...meta, after: 'user-200', removed: 1, written: 2 });
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token-1');
    expect(job.moveToDelayed.mock.calls[0][0]).toBeLessThanOrEqual(Date.now());
    expect(order).toEqual(['save', 'delay']);
    expect(extendedNetwork.rebuildAround).not.toHaveBeenCalled();
  });

  it('runs a later batch after the saved user, and adds its counts to the totals so far (#497)', async () => {
    extendedNetwork.rebuildAllBatch.mockResolvedValue({ removed: 3, written: 4, next: 'user-400' });

    await expect(
      run(ExtendedNetworkJobNames.RebuildAll, { after: 'user-200', removed: 1, written: 2 }),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(extendedNetwork.rebuildAllBatch).toHaveBeenCalledWith('user-200');
    expect(job.updateData).toHaveBeenCalledWith({ after: 'user-400', removed: 4, written: 6 });
  });

  it('completes with the totals after the last batch (#497)', async () => {
    extendedNetwork.rebuildAllBatch.mockResolvedValue({ removed: 3, written: 4, next: null });

    await expect(
      run(ExtendedNetworkJobNames.RebuildAll, { after: 'user-200', removed: 1, written: 2 }),
    ).resolves.toEqual({ removed: 4, written: 6 });

    expect(job.updateData).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  // Job data never changes, so neither job would ever succeed on a retry.
  it.each([
    ['a job name it does not know', 'friendship.extended-network.unknown', { userId: 'user-1' }],
    ['a rebuild around no user', ExtendedNetworkJobNames.RebuildAround, {}],
  ])('fails %s for good (#497)', async (_case, name, data) => {
    await expect(run(name, data)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(extendedNetwork.rebuildAround).not.toHaveBeenCalled();
    expect(extendedNetwork.rebuildAllBatch).not.toHaveBeenCalled();
  });
});
