import { AuditContextService, SystemActorScope } from '@bge/actor-context';
import { ContributionOrigin, MediaContribution, MediaContributionStatus, ResourceType } from '@bge/database';
import { StorageService } from '@bge/storage';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { MediaJobNames, MediaQueueNames } from '../constants/media-queue.constants';
import { MediaContributionSweepService } from './sweep.service';

describe('MediaContributionSweepService', () => {
  let service: MediaContributionSweepService;
  let db: MockDatabaseService;
  const queue = { add: jest.fn() };
  const storage = { driverSlug: 'localdisk' };
  const audit = {
    getActorOrThrow: jest.fn().mockReturnValue({ kind: 'system', reason: 'media-contribution-sweep' }),
    getCorrelationId: jest.fn().mockReturnValue('corr-1'),
  };
  const systemActorScope = { run: jest.fn((_r: string, fn: () => unknown) => fn()) };

  const eligible = (id: string) =>
    ({
      id,
      mediaObjectId: `mo-${id}`,
      contributedById: `u-${id}`,
      subjectType: ResourceType.Game,
      subjectId: `g-${id}`,
      mediaObject: { driverKey: `users/u/${id}`, driverSlug: 'localdisk' },
    }) as unknown as MediaContribution;

  beforeEach(async () => {
    jest.clearAllMocks();
    const ctx = await createTestingModuleWithDb({
      providers: [
        MediaContributionSweepService,
        { provide: StorageService, useValue: storage },
        { provide: AuditContextService, useValue: audit },
        { provide: SystemActorScope, useValue: systemActorScope },
        { provide: getQueueToken(MediaQueueNames.ContributionSweep), useValue: queue },
      ],
    });
    db = ctx.db;
    service = ctx.module.get(MediaContributionSweepService);
  });

  it('runs inside a named system actor scope', async () => {
    db.mediaContribution.findMany.mockResolvedValue([]);
    await service.sweepOnInterval();
    expect(systemActorScope.run).toHaveBeenCalledWith('media-contribution-sweep', expect.any(Function));
  });

  it('scans only expired rejected DirectUpload on the active driver', async () => {
    db.mediaContribution.findMany.mockResolvedValue([]);
    await service.dispatch();
    expect(db.mediaContribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: MediaContributionStatus.Rejected,
          origin: ContributionOrigin.DirectUpload,
          reclaimDeadline: { lte: expect.any(Date) },
          mediaObject: { driverSlug: 'localdisk' },
        }),
      }),
    );
  });

  it('enqueues one deduped purge job per eligible contribution', async () => {
    db.mediaContribution.findMany.mockResolvedValue([eligible('a'), eligible('b')]);
    const result = await service.dispatch();
    expect(result.enqueued).toBe(2);
    expect(queue.add).toHaveBeenCalledWith(
      MediaJobNames.PurgeContribution,
      expect.objectContaining({
        contributionId: 'a',
        mediaObjectId: 'mo-a',
        driverKey: 'users/u/a',
        driverSlug: 'localdisk',
        contributedById: 'u-a',
      }),
      expect.objectContaining({ jobId: 'a', attempts: 3 }),
    );
  });
});
