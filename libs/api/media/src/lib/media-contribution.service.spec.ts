import { ContributionOrigin, MediaContributionStatus, ResourceType, Visibility } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { ServiceAccountService } from '@bge/services';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaContributionEvents } from './constants/media-contribution-events.constant';
import { MediaContributionService } from './media-contribution.service';

describe('MediaContributionService', () => {
  let service: MediaContributionService;
  let db: MockDatabaseService;
  let ability: MockAbilityService;
  const emit = jest.fn();
  const serviceAccount = { resolve: jest.fn().mockResolvedValue({ id: 'svc' }), ensure: jest.fn() };

  const ownedMedia = { id: 'm1', ownerId: MOCK_ACTING_USER_ID };
  const dto = { subjectType: ResourceType.Game, subjectId: 'g1', category: 'rulebook' };

  beforeEach(async () => {
    ability = createMockAbilityService();
    const ctx = await createTestingModuleWithDb({
      providers: [
        MediaContributionService,
        { provide: AbilityService, useValue: ability },
        { provide: ServiceAccountService, useValue: serviceAccount },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    });
    db = ctx.db;
    service = ctx.module.get(MediaContributionService);
    db.$transaction.mockImplementation((cb) => cb(db));
  });

  describe('contribute', () => {
    beforeEach(() => {
      db.mediaContribution.findFirst.mockResolvedValue(null);
      db.mediaObject.findUnique.mockResolvedValue(ownedMedia as never);
    });

    it('auto-approves and flips ownership when approval is not required', async () => {
      db.systemSetting.findFirst.mockResolvedValue({ requireContributionApproval: false } as never);
      db.mediaContribution.create.mockResolvedValue({ id: 'c1' } as never);

      await service.contribute('m1', dto);

      expect(db.mediaContribution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MediaContributionStatus.Approved,
            origin: ContributionOrigin.ExistingMedia,
          }),
        }),
      );
      expect(db.mediaObject.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { ownerId: 'svc', visibility: Visibility.Public },
      });
    });

    it('creates a Pending record (no flip) when approval is required', async () => {
      db.systemSetting.findFirst.mockResolvedValue({ requireContributionApproval: true } as never);
      db.mediaContribution.create.mockResolvedValue({ id: 'c1' } as never);

      await service.contribute('m1', dto);

      expect(db.mediaContribution.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: MediaContributionStatus.Pending }) }),
      );
      expect(db.mediaObject.update).not.toHaveBeenCalled();
    });

    it('refuses to contribute media the caller does not own', async () => {
      db.mediaObject.findUnique.mockResolvedValue({ id: 'm1', ownerId: 'someone-else' } as never);
      await expect(service.contribute('m1', dto)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a duplicate when a Pending/Approved contribution already exists', async () => {
      db.mediaContribution.findFirst.mockResolvedValue({
        id: 'existing',
        status: MediaContributionStatus.Pending,
      } as never);
      await expect(service.contribute('m1', dto)).rejects.toBeInstanceOf(ConflictException);
      expect(db.mediaContribution.create).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('flips ownership and marks Approved with the reviewer', async () => {
      db.mediaContribution.findUnique.mockResolvedValue({
        id: 'c1',
        mediaObjectId: 'm1',
        status: MediaContributionStatus.Pending,
      } as never);
      db.mediaContribution.update.mockResolvedValue({ id: 'c1' } as never);

      await service.approve('c1');

      expect(db.mediaObject.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { ownerId: 'svc', visibility: Visibility.Public },
      });
      expect(db.mediaContribution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MediaContributionStatus.Approved,
            reviewedById: MOCK_ACTING_USER_ID,
          }),
        }),
      );
    });

    it('rejects approving a non-pending contribution', async () => {
      db.mediaContribution.findUnique.mockResolvedValue({
        id: 'c1',
        status: MediaContributionStatus.Approved,
      } as never);
      await expect(service.approve('c1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('reject', () => {
    it('sets a reclaim deadline for DirectUpload and emits the rejected event', async () => {
      db.mediaContribution.findUnique.mockResolvedValue({
        id: 'c1',
        mediaObjectId: 'm1',
        status: MediaContributionStatus.Pending,
        origin: ContributionOrigin.DirectUpload,
      } as never);
      db.systemSetting.findFirst.mockResolvedValue({ contributionReclaimDays: 14 } as never);
      db.mediaContribution.update.mockResolvedValue({
        id: 'c1',
        mediaObjectId: 'm1',
        contributedById: 'u1',
        subjectType: ResourceType.Game,
        subjectId: 'g1',
        rejectionReason: 'nope',
        reclaimDeadline: new Date(0),
      } as never);

      await service.reject('c1', { reason: 'nope' });

      expect(db.mediaContribution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MediaContributionStatus.Rejected,
            reclaimDeadline: expect.any(Date),
          }),
        }),
      );
      expect(emit).toHaveBeenCalledWith(
        MediaContributionEvents.Rejected,
        expect.objectContaining({ contributedById: 'u1' }),
      );
    });

    it('leaves ExistingMedia with no reclaim deadline', async () => {
      db.mediaContribution.findUnique.mockResolvedValue({
        id: 'c1',
        mediaObjectId: 'm1',
        status: MediaContributionStatus.Pending,
        origin: ContributionOrigin.ExistingMedia,
      } as never);
      db.mediaContribution.update.mockResolvedValue({
        id: 'c1',
        mediaObjectId: 'm1',
        contributedById: 'u1',
        subjectType: ResourceType.Game,
        subjectId: 'g1',
        rejectionReason: null,
        reclaimDeadline: null,
      } as never);

      await service.reject('c1', {});

      expect(db.mediaContribution.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reclaimDeadline: null }) }),
      );
    });
  });

  describe('reclaim', () => {
    it('reclaims a rejected contribution within the window', async () => {
      db.mediaContribution.findUnique.mockResolvedValue({
        id: 'c1',
        contributedById: MOCK_ACTING_USER_ID,
        status: MediaContributionStatus.Rejected,
        reclaimDeadline: new Date(Date.now() + 1e6),
      } as never);
      db.mediaContribution.update.mockResolvedValue({ id: 'c1' } as never);

      await service.reclaim('c1');
      expect(db.mediaContribution.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: MediaContributionStatus.Reclaimed },
      });
    });

    it('refuses after the window has closed', async () => {
      db.mediaContribution.findUnique.mockResolvedValue({
        id: 'c1',
        contributedById: MOCK_ACTING_USER_ID,
        status: MediaContributionStatus.Rejected,
        reclaimDeadline: new Date(0),
      } as never);
      await expect(service.reclaim('c1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to reclaim someone else’s contribution', async () => {
      db.mediaContribution.findUnique.mockResolvedValue({
        id: 'c1',
        contributedById: 'other',
        status: MediaContributionStatus.Rejected,
      } as never);
      await expect(service.reclaim('c1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
