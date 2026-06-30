import type { JobMetaEnvelope } from '@bge/queue-actor-context';
import {
  DriverNotRegisteredError,
  InsufficientStorageError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import { Job, UnrecoverableError } from 'bullmq';
import type { PurgeContributionJob } from '../interfaces/purge-contribution-job.interface';
import { MediaContributionPurgeProcessor } from './purge.processor';
import type { MediaContributionPurgeService } from './purge.service';

type JobData = PurgeContributionJob & JobMetaEnvelope;

describe('MediaContributionPurgeProcessor (retry classification)', () => {
  const purge = { purge: jest.fn() } satisfies Partial<jest.Mocked<MediaContributionPurgeService>>;
  const processor = new MediaContributionPurgeProcessor(purge as unknown as MediaContributionPurgeService);

  const job = { data: {} as JobData } as Job<JobData>;
  const run = (): Promise<void> =>
    (processor as unknown as { processJob: (j: Job<JobData>) => Promise<void> }).processJob(job);

  beforeEach(() => jest.clearAllMocks());

  it('completes when the purge resolves', async () => {
    purge.purge.mockResolvedValue(undefined);
    await expect(run()).resolves.toBeUndefined();
  });

  it('rethrows a retryable StorageUnavailableError so BullMQ retries with backoff', async () => {
    purge.purge.mockRejectedValue(new StorageUnavailableError('blip', { retryable: true }));
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    ['non-retryable unavailable', new StorageUnavailableError('denied', { retryable: false })],
    ['insufficient storage', new InsufficientStorageError('full')],
    ['misconfigured', new StorageMisconfiguredError('bad config')],
    ['unregistered driver', new DriverNotRegisteredError('s3')],
  ])('wraps a terminal failure (%s) in UnrecoverableError', async (_label, error) => {
    purge.purge.mockRejectedValue(error);
    await expect(run()).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows an unmodeled error unchanged for normal retry handling', async () => {
    const boom = new Error('boom');
    purge.purge.mockRejectedValue(boom);
    await expect(run()).rejects.toBe(boom);
  });
});
