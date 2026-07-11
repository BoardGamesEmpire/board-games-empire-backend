import type { Friendship } from '@bge/database';
import { Action, FriendshipStatus, Prisma, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FriendshipService } from './friendship.service';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

const acceptingUser = { id: 'user-2', preferences: { allowFriendRequests: true } };

const COND = { id: 'sentinel-condition' };
const ME = 'user-1';
const OTHER = 'user-2';

const friendship = (overrides: Partial<Friendship> = {}): Friendship =>
  ({
    id: 'f-1',
    requesterId: ME,
    addresseeId: OTHER,
    status: FriendshipStatus.Pending,
    message: null,
    respondedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Friendship;

describe('FriendshipService', () => {
  let service: FriendshipService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId'>>;

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue(ME),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [FriendshipService, { provide: AbilityService, useValue: abilityService }],
    });

    db = ctx.db;
    service = ctx.module.get(FriendshipService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('rejects a self-request', async () => {
      await expect(service.create({ addresseeId: ME })).rejects.toThrow(BadRequestException);
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('rejects when the addressee does not exist', async () => {
      db.user.findUnique.mockResolvedValue(null);
      await expect(service.create({ addresseeId: OTHER })).rejects.toThrow(NotFoundException);
    });

    it('rejects when the addressee is not accepting requests', async () => {
      db.user.findUnique.mockResolvedValue({ id: OTHER, preferences: { allowFriendRequests: false } } as never);
      await expect(service.create({ addresseeId: OTHER })).rejects.toThrow(ForbiddenException);
    });

    it('rejects a reverse-direction duplicate that is already accepted', async () => {
      db.user.findUnique.mockResolvedValue(acceptingUser as never);
      db.friendship.findUnique.mockResolvedValue(
        friendship({ requesterId: OTHER, addresseeId: ME, status: FriendshipStatus.Accepted }),
      );
      await expect(service.create({ addresseeId: OTHER })).rejects.toThrow(BadRequestException);
      expect(db.friendship.upsert).not.toHaveBeenCalled();
    });

    it('is forbidden to request when a block exists', async () => {
      db.user.findUnique.mockResolvedValue(acceptingUser as never);
      db.friendship.findUnique.mockResolvedValue(friendship({ status: FriendshipStatus.Blocked }));
      await expect(service.create({ addresseeId: OTHER })).rejects.toThrow(ForbiddenException);
      expect(db.friendship.upsert).not.toHaveBeenCalled();
    });

    it('reactivates a declined row and clears its stale message', async () => {
      db.user.findUnique.mockResolvedValue(acceptingUser as never);
      db.friendship.findUnique.mockResolvedValue(
        friendship({ requesterId: OTHER, addresseeId: ME, status: FriendshipStatus.Declined, message: 'old note' }),
      );
      db.friendship.upsert.mockResolvedValue(friendship());

      await service.create({ addresseeId: OTHER });

      // Upsert is keyed on the canonical pair key and reactivates via the update
      // branch; an omitted message resets to null (not left unchanged). The
      // where pins the row to a repurposable status so a concurrent write can't
      // be clobbered (see the guard test below).
      const call = db.friendship.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        pairKey: [ME, OTHER].sort().join(':'),
        status: { in: [FriendshipStatus.Declined, FriendshipStatus.Withdrawn] },
      });
      expect(call.update).toEqual(
        expect.objectContaining({
          requesterId: ME,
          addresseeId: OTHER,
          status: FriendshipStatus.Pending,
          message: null,
          respondedAt: null,
        }),
      );
    });

    it('creates a pending request via upsert when none exists', async () => {
      db.user.findUnique.mockResolvedValue(acceptingUser as never);
      db.friendship.findUnique.mockResolvedValue(null);
      db.friendship.upsert.mockResolvedValue(friendship());

      await service.create({ addresseeId: OTHER });

      const call = db.friendship.upsert.mock.calls[0][0];
      expect(call.create).toEqual(
        expect.objectContaining({ requesterId: ME, addresseeId: OTHER, pairKey: [ME, OTHER].sort().join(':') }),
      );
    });

    it('maps a unique-constraint race to a 409 Conflict', async () => {
      db.user.findUnique.mockResolvedValue(acceptingUser as never);
      db.friendship.findUnique.mockResolvedValue(null);
      db.friendship.upsert.mockRejectedValue(uniqueViolation());

      await expect(service.create({ addresseeId: OTHER })).rejects.toThrow(ConflictException);
    });

    // Regression: the pre-check runs on a stale snapshot, so the upsert's update
    // branch must only fire on a row still Declined/Withdrawn. Pinning the where
    // to those statuses means a row a concurrent request moved to
    // Pending/Accepted/Blocked no longer matches — it falls through to create and
    // the pairKey unique constraint yields a 409 instead of a silent status flip.
    it('restricts the upsert update branch to repurposable statuses', async () => {
      db.user.findUnique.mockResolvedValue(acceptingUser as never);
      db.friendship.findUnique.mockResolvedValue(null);
      db.friendship.upsert.mockResolvedValue(friendship());

      await service.create({ addresseeId: OTHER });

      const call = db.friendship.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        pairKey: [ME, OTHER].sort().join(':'),
        status: { in: [FriendshipStatus.Declined, FriendshipStatus.Withdrawn] },
      });
    });
  });

  describe('respond', () => {
    it('lets the addressee accept a pending request', async () => {
      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: OTHER, addresseeId: ME }));
      db.friendship.update.mockResolvedValue(friendship({ status: FriendshipStatus.Accepted }));

      await service.respond('f-1', FriendshipStatus.Accepted);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Friendship, Action.update);
      expect(db.friendship.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'f-1', AND: [COND] }) }),
      );
    });

    it('forbids the requester from accepting their own request', async () => {
      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: ME, addresseeId: OTHER }));
      await expect(service.respond('f-1', FriendshipStatus.Accepted)).rejects.toThrow(ForbiddenException);
    });

    it('rejects accepting a non-pending request', async () => {
      db.friendship.findUnique.mockResolvedValue(
        friendship({ requesterId: OTHER, addresseeId: ME, status: FriendshipStatus.Accepted }),
      );
      await expect(service.respond('f-1', FriendshipStatus.Accepted)).rejects.toThrow(BadRequestException);
    });

    it('forbids the addressee from withdrawing', async () => {
      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: OTHER, addresseeId: ME }));
      await expect(service.respond('f-1', FriendshipStatus.Withdrawn)).rejects.toThrow(ForbiddenException);
    });

    it('reorients the row so the blocker becomes the requester', async () => {
      db.friendship.findUnique.mockResolvedValue(
        friendship({ requesterId: OTHER, addresseeId: ME, status: FriendshipStatus.Accepted }),
      );
      db.friendship.update.mockResolvedValue(friendship({ status: FriendshipStatus.Blocked }));

      await service.respond('f-1', FriendshipStatus.Blocked);

      expect(db.friendship.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: FriendshipStatus.Blocked,
            requester: { connect: { id: ME } },
            addressee: { connect: { id: OTHER } },
          }),
        }),
      );
    });

    it('throws NotFound when the friendship is not visible', async () => {
      db.friendship.findUnique.mockResolvedValue(null);
      await expect(service.respond('f-1', FriendshipStatus.Accepted)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('forbids the blocked party from deleting the block', async () => {
      // Blocker is OTHER (requester of the blocked row); acting user is ME.
      db.friendship.findUnique.mockResolvedValue(
        friendship({ requesterId: OTHER, addresseeId: ME, status: FriendshipStatus.Blocked }),
      );
      await expect(service.remove('f-1')).rejects.toThrow(ForbiddenException);
      expect(db.friendship.delete).not.toHaveBeenCalled();
    });

    it('lets a participant unfriend', async () => {
      db.friendship.findUnique.mockResolvedValue(friendship({ status: FriendshipStatus.Accepted }));
      db.friendship.delete.mockResolvedValue(friendship());

      await service.remove('f-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Friendship, Action.delete);
      expect(db.friendship.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'f-1', AND: [COND] }) }),
      );
    });
  });

  describe('reads', () => {
    it('listForUser scopes by read conditions and applies the status filter', async () => {
      db.friendship.findMany.mockResolvedValue([]);

      await service.listForUser({ status: FriendshipStatus.Accepted, offset: 0, limit: 10 });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Friendship, Action.read);
      expect(db.friendship.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ AND: [COND], status: FriendshipStatus.Accepted }),
        }),
      );
    });

    it('listIncomingRequests filters to pending requests addressed to the acting user', async () => {
      db.friendship.findMany.mockResolvedValue([]);

      await service.listIncomingRequests({ offset: 0, limit: 10 });

      expect(db.friendship.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ addresseeId: ME, status: FriendshipStatus.Pending, AND: [COND] }),
        }),
      );
    });
  });
});
