import { Action, ContributionOrigin, MediaContributionStatus, Prisma, ResourceType, Visibility } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { ServiceAccountService } from '@bge/services';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  MOCK_RESOURCE_CONDITION,
  shippedReadReaches,
  unwrapTransaction,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { MediaContributionEvents } from './constants/media-contribution-events.constant';
import { ListContributionsQueryDto } from './dto';
import { MediaLinkService } from './link/link.service';
import { MediaContributionService } from './media-contribution.service';

describe('MediaContributionService', () => {
  let service: MediaContributionService;
  let db: MockDatabaseService;
  let ability: MockAbilityService;
  let compose: jest.SpyInstance;
  const emit = jest.fn();
  const serviceAccount = { resolve: jest.fn().mockResolvedValue({ id: 'svc' }), ensure: jest.fn() };
  const mediaLink = {
    attachWithin: jest.fn(),
    canLink: jest.fn().mockReturnValue(true),
    assertSubjectReadable: jest.fn().mockResolvedValue(undefined),
  };

  const ownedMedia = { id: 'm1', ownerId: MOCK_ACTING_USER_ID };
  const dto = { subjectType: ResourceType.Game, subjectId: 'g1', category: 'rulebook' };

  beforeEach(async () => {
    ability = createMockAbilityService();
    const ctx = await createTestingModuleWithDb({
      providers: [
        MediaContributionService,
        // The REAL composer over the mocked ability service, so the list's
        // where-clause assertions test the merge rather than a double.
        ScopeComposer,
        { provide: AbilityService, useValue: ability },
        { provide: ServiceAccountService, useValue: serviceAccount },
        { provide: EventEmitter2, useValue: { emit } },
        { provide: MediaLinkService, useValue: mediaLink },
      ],
    });
    db = ctx.db;
    service = ctx.module.get(MediaContributionService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
    unwrapTransaction(db);
  });

  afterEach(() => jest.clearAllMocks());

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

    it('attaches to the subject on auto-approve', async () => {
      db.systemSetting.findFirst.mockResolvedValue({ requireContributionApproval: false } as never);
      db.mediaContribution.create.mockResolvedValue({ id: 'c1' } as never);
      await service.contribute('m1', dto);
      expect(mediaLink.attachWithin).toHaveBeenCalledWith(
        expect.anything(),
        'm1',
        expect.objectContaining({ subjectType: dto.subjectType, subjectId: dto.subjectId }),
      );
    });

    it('rejects contributing a non-linkable media type', async () => {
      mediaLink.canLink.mockReturnValueOnce(false);
      await expect(service.contribute('m1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('checks, inside the transaction, that the contributor can read the subject', async () => {
      db.systemSetting.findFirst.mockResolvedValue({ requireContributionApproval: true } as never);
      db.mediaContribution.create.mockResolvedValue({ id: 'c1' } as never);

      await service.contribute('m1', dto);

      expect(mediaLink.assertSubjectReadable).toHaveBeenCalledWith(dto.subjectType, dto.subjectId, db);
    });

    // Read is the bar for attaching media, and an auto-approved contribution
    // attaches with no reviewer in between (#472: a private game is its
    // creator's). A held one is refused too: a reviewer should never be asked
    // to attach to a subject its contributor cannot see.
    it.each([
      ['auto-approved', false],
      ['held for review', true],
    ])(
      'refuses a subject the contributor cannot read, before anything is written (%s)',
      async (_, requireContributionApproval) => {
        db.systemSetting.findFirst.mockResolvedValue({ requireContributionApproval } as never);
        mediaLink.assertSubjectReadable.mockRejectedValueOnce(new ForbiddenException());

        await expect(service.contribute('m1', dto)).rejects.toBeInstanceOf(ForbiddenException);

        expect(db.mediaContribution.create).not.toHaveBeenCalled();
        expect(db.mediaObject.update).not.toHaveBeenCalled();
        expect(mediaLink.attachWithin).not.toHaveBeenCalled();
      },
    );
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

    it('attaches to the subject on approve', async () => {
      db.mediaContribution.findUnique.mockResolvedValue({
        id: 'c1',
        mediaObjectId: 'm1',
        status: MediaContributionStatus.Pending,
        subjectType: ResourceType.Game,
        subjectId: 'g1',
        category: 'rulebook',
      } as never);
      db.mediaContribution.update.mockResolvedValue({ id: 'c1' } as never);
      await service.approve('c1');
      expect(mediaLink.attachWithin).toHaveBeenCalledWith(
        expect.anything(),
        'm1',
        expect.objectContaining({ subjectType: ResourceType.Game, subjectId: 'g1' }),
      );
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

  describe('createContributionWithin', () => {
    it('records the given origin (DirectUpload) and auto-approves when approval is off', async () => {
      db.mediaObject.findUnique.mockResolvedValue({ mimeType: 'image/png' } as never);
      db.mediaContribution.findFirst.mockResolvedValue(null);
      db.systemSetting.findFirst.mockResolvedValue({ requireContributionApproval: false } as never);
      db.mediaContribution.create.mockResolvedValue({ id: 'c1' } as never);

      await service.createContributionWithin(
        db as never,
        'm1',
        dto,
        ContributionOrigin.DirectUpload,
        MOCK_ACTING_USER_ID,
      );

      expect(db.mediaContribution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            origin: ContributionOrigin.DirectUpload,
            status: MediaContributionStatus.Approved,
          }),
        }),
      );
      expect(mediaLink.attachWithin).toHaveBeenCalled();
    });

    it('refuses a DirectUpload to a subject the contributor cannot read', async () => {
      db.mediaObject.findUnique.mockResolvedValue({ mimeType: 'image/png' } as never);
      db.mediaContribution.findFirst.mockResolvedValue(null);
      db.systemSetting.findFirst.mockResolvedValue({ requireContributionApproval: false } as never);
      mediaLink.assertSubjectReadable.mockRejectedValueOnce(new ForbiddenException());

      await expect(
        service.createContributionWithin(db as never, 'm1', dto, ContributionOrigin.DirectUpload, MOCK_ACTING_USER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.mediaContribution.create).not.toHaveBeenCalled();
      expect(mediaLink.attachWithin).not.toHaveBeenCalled();
    });
  });

  describe('list (#372)', () => {
    const query = (init: Partial<{ status: MediaContributionStatus; page: number; limit: number }> = {}) =>
      plainToInstance(ListContributionsQueryDto, init, { enableImplicitConversion: true });

    beforeEach(() => {
      db.mediaContribution.findMany.mockResolvedValue([]);
      db.mediaContribution.count.mockResolvedValue(0);
    });

    it('composes MediaContribution as unscoped', async () => {
      await service.list(query());

      expect(compose).toHaveBeenCalledWith(
        ResourceType.MediaContribution,
        Action.read,
        expect.objectContaining({ kind: 'unscoped', reason: expect.any(String) }),
      );
    });

    // The Unscoped reason is a claim about the catalog, and this is where it is
    // checked: a conditioned read granted later fails here, beside the
    // declaration it would falsify, and not only in the catalog's own pin.
    it('stays unscoped only while every catalog role that reads contributions reads every row', () => {
      expect(new Set(shippedReadReaches(ResourceType.MediaContribution))).toEqual(new Set(['every row']));
    });

    it('reads the rows and the count in one REPEATABLE READ transaction', async () => {
      await service.list(query());

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // A moderation queue is read by its length, so a `total` that ignored the
    // status filter would report the whole history as the work outstanding.
    it('counts through the same status-filtered where as the rows', async () => {
      db.mediaContribution.count.mockResolvedValue(6);

      const page = await service.list(query({ status: MediaContributionStatus.Pending }));

      const where = { AND: [{ AND: [MOCK_RESOURCE_CONDITION] }, { status: MediaContributionStatus.Pending }] };
      expect(db.mediaContribution.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(db.mediaContribution.count).toHaveBeenCalledWith({ where });
      expect(page).toEqual({ rows: [], total: 6 });
    });

    it('omits the status clause entirely when no status is asked for', async () => {
      await service.list(query());

      expect(db.mediaContribution.count).toHaveBeenCalledWith({ where: { AND: [{ AND: [MOCK_RESOURCE_CONDITION] }] } });
    });
  });
});
