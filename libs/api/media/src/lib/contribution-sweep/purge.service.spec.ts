import { NotificationType, Prisma, ResourceType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { StorageService } from '@bge/storage';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { ObjectNotFoundError } from '@boardgamesempire/storage-contract';
import { MediaContributionPurgeService } from './purge.service';

describe('MediaContributionPurgeService', () => {
  let service: MediaContributionPurgeService;
  let db: MockDatabaseService;
  const storage = { delete: jest.fn().mockResolvedValue(undefined), driverSlug: 'localdisk' };
  const notifications = { create: jest.fn().mockResolvedValue(undefined) };

  const job = {
    contributionId: 'c1',
    mediaObjectId: 'mo1',
    driverKey: 'users/u/mo1',
    driverSlug: 'localdisk',
    contributedById: 'u1',
    subjectType: ResourceType.Game,
    subjectId: 'g1',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const ctx = await createTestingModuleWithDb({
      providers: [
        MediaContributionPurgeService,
        { provide: StorageService, useValue: storage },
        { provide: NotificationsService, useValue: notifications },
      ],
    });
    db = ctx.db;
    service = ctx.module.get(MediaContributionPurgeService);
    db.mediaObject.delete.mockResolvedValue({} as never);
  });

  it('deletes bytes, deletes the row, then notifies the contributor', async () => {
    await service.purge(job);
    expect(storage.delete).toHaveBeenCalledWith('users/u/mo1');
    expect(db.mediaObject.delete).toHaveBeenCalledWith({ where: { id: 'mo1' } });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: NotificationType.MediaContributionReclaimExpired }),
    );
  });

  it('tolerates already-deleted bytes', async () => {
    storage.delete.mockRejectedValueOnce(new ObjectNotFoundError('users/u/mo1'));
    await expect(service.purge(job)).resolves.toBeUndefined();
    expect(db.mediaObject.delete).toHaveBeenCalled();
  });

  it('does not notify when another runner already deleted the row', async () => {
    db.mediaObject.delete.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: '7' }),
    );
    await service.purge(job);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('keeps the job green if notify fails (best-effort)', async () => {
    notifications.create.mockRejectedValueOnce(new Error('notify down'));
    await expect(service.purge(job)).resolves.toBeUndefined();
  });

  it('refuses to delete from a non-active driver (#100)', async () => {
    await service.purge({ ...job, driverSlug: 's3' });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(db.mediaObject.delete).not.toHaveBeenCalled();
  });
});
