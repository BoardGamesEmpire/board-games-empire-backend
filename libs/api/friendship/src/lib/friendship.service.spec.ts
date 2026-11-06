import type { Friendship } from '@bge/database';
import { Action, FriendshipStatus, Prisma, ResourceType } from '@bge/database';
import { uniqueViolationWithoutMeta } from '@bge/database/testing';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExtendedNetworkProducer } from './extended-network/extended-network.producer';
import { FriendshipService } from './friendship.service';

/**
 * A P2002 with no `meta`, which is what `@prisma/client@7.8.0` +
 * `@prisma/adapter-pg` raises (#298). Fabricated through `@bge/database`'s shared
 * factory rather than locally so there is one definition of the shape, pinned
 * against a real database by `apps/api-e2e/src/database/p2002-shape.spec.ts`.
 */
const uniqueViolation = uniqueViolationWithoutMeta;

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
  let compose: jest.SpyInstance;
  let extendedNetwork: jest.Mocked<Pick<ExtendedNetworkProducer, 'changed'>>;

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue(ME),
    };
    extendedNetwork = { changed: jest.fn().mockResolvedValue(undefined) };

    const ctx = await createTestingModuleWithDb({
      providers: [
        FriendshipService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the lists actually run.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: ExtendedNetworkProducer, useValue: extendedNetwork },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(FriendshipService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
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

    // A request is no friendship step, so the extended network table has nothing to
    // rebuild (#497). The upsert writes `Pending` over no row or a declined or
    // withdrawn one, never over an accepted one.
    it('queues no extended network table rebuild for a request (#497)', async () => {
      db.user.findUnique.mockResolvedValue(acceptingUser as never);
      db.friendship.findUnique.mockResolvedValue(null);
      db.friendship.upsert.mockResolvedValue(friendship() as never);

      await service.create({ addresseeId: OTHER });

      expect(db.friendship.upsert).toHaveBeenCalled();
      expect(extendedNetwork.changed).not.toHaveBeenCalled();
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

    // A response read the row as Pending, but a concurrent one may have moved
    // it since. Writing only while it is still Pending means a withdrawal
    // can't undo an accept it lost the race to, and it lets a decline or a
    // withdrawal skip the extended network table's rebuild (#497).
    it.each([
      ['an accept', FriendshipStatus.Accepted, friendship({ requesterId: OTHER, addresseeId: ME })],
      ['a decline', FriendshipStatus.Declined, friendship({ requesterId: OTHER, addresseeId: ME })],
      ['a withdrawal', FriendshipStatus.Withdrawn, friendship({ requesterId: ME, addresseeId: OTHER })],
    ] as const)('writes %s only while the row is still Pending (#497)', async (_case, status, row) => {
      db.friendship.findUnique.mockResolvedValue(row);
      db.friendship.update.mockResolvedValue(friendship({ status }));

      await service.respond('f-1', status);

      expect(db.friendship.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'f-1', status: FriendshipStatus.Pending, AND: [COND] }),
        }),
      );
    });

    it('refuses a response a concurrent one overtook as no longer pending (#497)', async () => {
      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: ME, addresseeId: OTHER }));
      db.friendship.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(service.respond('f-1', FriendshipStatus.Withdrawn)).rejects.toThrow(BadRequestException);
      expect(extendedNetwork.changed).not.toHaveBeenCalled();
    });

    // A block can end a friendship from any status, so its write is not
    // pinned to the status it read.
    it('writes a block whatever status the row moved to (#497)', async () => {
      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: OTHER, addresseeId: ME }));
      db.friendship.update.mockResolvedValue(friendship({ status: FriendshipStatus.Blocked }));

      await service.respond('f-1', FriendshipStatus.Blocked);

      expect(db.friendship.update.mock.calls[0][0].where).not.toHaveProperty('status');
    });

    // The extended network table counts accepted friendships only (#497). An accept
    // adds one, and a block can end one, so both queue a rebuild of both
    // users' neighbourhoods once written.
    it.each([
      ['an accept', FriendshipStatus.Accepted, friendship({ requesterId: OTHER, addresseeId: ME })],
      [
        'a block',
        FriendshipStatus.Blocked,
        friendship({ requesterId: OTHER, addresseeId: ME, status: FriendshipStatus.Accepted }),
      ],
      ['a block of a request', FriendshipStatus.Blocked, friendship({ requesterId: OTHER, addresseeId: ME })],
    ] as const)(
      "queues both users' extended network table rebuilds once %s is written (#497)",
      async (_case, status, row) => {
        // The database mocks and this one count calls on separate counters, so
        // the order is logged rather than read from `invocationCallOrder`.
        const order: string[] = [];
        db.friendship.findUnique.mockResolvedValue(row);
        db.friendship.update.mockImplementation((async () => {
          order.push('update');
          return friendship({ requesterId: OTHER, addresseeId: ME, status });
        }) as never);
        extendedNetwork.changed.mockImplementation(async () => {
          order.push('queue');
        });

        await service.respond('f-1', status);

        expect(extendedNetwork.changed).toHaveBeenCalledTimes(1);
        expect([...extendedNetwork.changed.mock.calls[0][0]].sort()).toEqual([ME, OTHER].sort());
        expect(order).toEqual(['update', 'queue']);
      },
    );

    // The guarded write proves the row was Pending, which no step counts, and
    // a decline or a withdrawal leaves it unaccepted.
    it.each([
      ['a decline', FriendshipStatus.Declined, friendship({ requesterId: OTHER, addresseeId: ME })],
      ['a withdrawal', FriendshipStatus.Withdrawn, friendship({ requesterId: ME, addresseeId: OTHER })],
    ] as const)('queues no extended network table rebuild for %s (#497)', async (_case, status, row) => {
      db.friendship.findUnique.mockResolvedValue(row);
      db.friendship.update.mockResolvedValue(friendship({ status }));

      await service.respond('f-1', status);

      expect(extendedNetwork.changed).not.toHaveBeenCalled();
    });

    // While the queue's Redis is unreachable, queueing neither settles nor
    // rejects. The friendship is already written, so the request answers.
    it('answers without waiting for the rebuild to be queued (#497)', async () => {
      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: OTHER, addresseeId: ME }));
      db.friendship.update.mockResolvedValue(friendship({ status: FriendshipStatus.Accepted }));
      extendedNetwork.changed.mockReturnValue(new Promise<void>(() => undefined));

      await expect(service.respond('f-1', FriendshipStatus.Accepted)).resolves.toEqual(
        expect.objectContaining({ status: FriendshipStatus.Accepted }),
      );
      expect(extendedNetwork.changed).toHaveBeenCalledTimes(1);
    });

    it('queues no extended network table rebuild for a response that is refused, or that matches no row it may change (#497)', async () => {
      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: ME, addresseeId: OTHER }));
      await expect(service.respond('f-1', FriendshipStatus.Accepted)).rejects.toThrow(ForbiddenException);

      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: OTHER, addresseeId: ME }));
      db.friendship.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );
      await expect(service.respond('f-1', FriendshipStatus.Blocked)).rejects.toThrow(ForbiddenException);

      expect(extendedNetwork.changed).not.toHaveBeenCalled();
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

    // An unfriend removes a friendship step, and the extended network table loses it
    // only when this rebuild runs (#497).
    it("queues both users' extended network table rebuilds once a removal is written (#497)", async () => {
      const order: string[] = [];
      db.friendship.findUnique.mockResolvedValue(friendship({ status: FriendshipStatus.Accepted }));
      db.friendship.delete.mockImplementation((async () => {
        order.push('delete');
        return friendship({ status: FriendshipStatus.Accepted });
      }) as never);
      extendedNetwork.changed.mockImplementation(async () => {
        order.push('queue');
      });

      await service.remove('f-1');

      expect(extendedNetwork.changed).toHaveBeenCalledTimes(1);
      expect([...extendedNetwork.changed.mock.calls[0][0]].sort()).toEqual([ME, OTHER].sort());
      expect(order).toEqual(['delete', 'queue']);
    });

    // The status is the deleted row's own, so no concurrent change can make
    // it stale. An unblock or a removed request ends no accepted friendship.
    it.each([
      ['an unblock', FriendshipStatus.Blocked],
      ['a removed request', FriendshipStatus.Pending],
      ['a removed declined request', FriendshipStatus.Declined],
    ] as const)('queues no extended network table rebuild for %s (#497)', async (_case, status) => {
      db.friendship.findUnique.mockResolvedValue(friendship({ requesterId: ME, addresseeId: OTHER, status }));
      db.friendship.delete.mockResolvedValue(friendship({ requesterId: ME, addresseeId: OTHER, status }));

      await service.remove('f-1');

      expect(extendedNetwork.changed).not.toHaveBeenCalled();
    });

    it('queues no extended network table rebuild for a removal that is refused (#497)', async () => {
      db.friendship.findUnique.mockResolvedValue(
        friendship({ requesterId: OTHER, addresseeId: ME, status: FriendshipStatus.Blocked }),
      );
      await expect(service.remove('f-1')).rejects.toThrow(ForbiddenException);

      db.friendship.findUnique.mockResolvedValue(friendship({ status: FriendshipStatus.Accepted }));
      db.friendship.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('No record was found for a delete.', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );
      await expect(service.remove('f-1')).rejects.toThrow(ForbiddenException);

      expect(extendedNetwork.changed).not.toHaveBeenCalled();
    });
  });

  /**
   * #515. Both reads declare their own set, the acting user's friendships, and
   * the ceiling only clips it. Staff and the Owner read every friendship on the
   * server through their wildcard rules, so before this the wide list showed
   * them everyone's. `Friendship`'s envelope is guarded, so a read
   * that stops composing answers 500 at the envelope rather than widening
   * again. That is why the composer call itself is pinned.
   */
  describe('reads', () => {
    const MINE = { OR: [{ requesterId: ME }, { addresseeId: ME }] };

    beforeEach(() => {
      db.friendship.findMany.mockResolvedValue([]);
      db.friendship.count.mockResolvedValue(0);
    });

    it("listForUser asks the composer for its where clause, declaring the acting user's friendships", async () => {
      await service.listForUser(paginationQuery({ limit: 10 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.Friendship, Action.read, MINE);
    });

    // The status filter is a query parameter, not scope, so it sits beside the
    // composed clause rather than inside it.
    it('listForUser queries with the composed clause and the status filter beside it', async () => {
      await service.listForUser(Object.assign(paginationQuery({ limit: 10 }), { status: FriendshipStatus.Accepted }));

      expect(db.friendship.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [{ ...MINE, AND: [COND] }, { status: FriendshipStatus.Accepted }] },
        }),
      );
    });

    it('listForUser applies no status filter when none is asked for', async () => {
      await service.listForUser(paginationQuery({ limit: 10 }));

      expect(db.friendship.findMany.mock.calls[0][0]?.where).toEqual({ AND: [{ ...MINE, AND: [COND] }, {}] });
    });

    it("listIncomingRequests asks the composer for its where clause, declaring the acting user's pending requests", async () => {
      await service.listIncomingRequests(paginationQuery({ limit: 10 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.Friendship, Action.read, {
        addresseeId: ME,
        status: FriendshipStatus.Pending,
      });
      expect(db.friendship.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { addresseeId: ME, status: FriendshipStatus.Pending, AND: [COND] },
        }),
      );
    });

    // PROVISIONAL (#395). "My friendships" has no meaning for an actor with no
    // user behind it, and the refusal must not soften into an empty page. The
    // wide list used to ask for no user at all, and answered such an actor
    // with whatever its ceiling admitted.
    it.each([
      ['listForUser', (q: ReturnType<typeof paginationQuery>) => service.listForUser(q)],
      ['listIncomingRequests', (q: ReturnType<typeof paginationQuery>) => service.listIncomingRequests(q)],
    ])('%s refuses an actor kind with no user behind it, with a message about reading', async (_name, read) => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await read(paginationQuery({ limit: 10 })).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.friendship.findMany).not.toHaveBeenCalled();
    });

    // #372: both reads go through one shared paginate helper, so the snapshot
    // guarantee has to hold for each of them — this list is the view of exactly
    // the writes (a request accepted, a friendship removed) that would otherwise
    // land between the rows and the count.
    it.each([
      ['listForUser', (q: ReturnType<typeof paginationQuery>) => service.listForUser(q)],
      ['listIncomingRequests', (q: ReturnType<typeof paginationQuery>) => service.listIncomingRequests(q)],
    ])('%s reads rows and count in one REPEATABLE READ transaction', async (_name, read) => {
      await read(paginationQuery({ limit: 10 }));

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // The status filter narrows the rows, so it must narrow the count too — an
    // Accepted-only page whose `total` counted pending requests as well would
    // advertise pages that come back empty.
    it('counts through the same scoped, status-filtered where as the rows', async () => {
      db.friendship.count.mockResolvedValue(5);

      const page = await service.listForUser(
        Object.assign(paginationQuery({ limit: 10 }), { status: FriendshipStatus.Accepted }),
      );

      expect(db.friendship.count).toHaveBeenCalledWith({
        where: { AND: [{ ...MINE, AND: [COND] }, { status: FriendshipStatus.Accepted }] },
      });
      expect(page).toEqual({ rows: [], total: 5 });
    });

    // The incoming-requests read has a narrower scope than the wide list; a
    // count that lost the addressee clause would total every pending request on
    // the instance the caller may read.
    it('counts incoming requests through the addressee-scoped where', async () => {
      db.friendship.count.mockResolvedValue(2);

      await service.listIncomingRequests(paginationQuery({ limit: 10 }));

      expect(db.friendship.count).toHaveBeenCalledWith({
        where: { addresseeId: ME, status: FriendshipStatus.Pending, AND: [COND] },
      });
    });
  });
});
