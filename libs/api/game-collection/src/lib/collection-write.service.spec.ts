import type { GameCollection, Prisma } from '@bge/database';
import { Action, GameMedium, GameRemovalReason, ResourceType } from '@bge/database';
import type { CollectionSupplyChange } from '@bge/event';
import { emitCollectionSupplyChanges, syncCollectionEntrySupply } from '@bge/event';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, rawQueryText, unwrapTransaction } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CollectionWriteService } from './collection-write.service';

// The supply sync has its own spec in `@bge/event`; here it is a seam, so the
// tests below pin when a write runs it and what they pass (#1221).
jest.mock('@bge/event', () => ({
  syncCollectionEntrySupply: jest.fn(),
  emitCollectionSupplyChanges: jest.fn(),
}));

const syncSupply = jest.mocked(syncCollectionEntrySupply);
const emitSupply = jest.mocked(emitCollectionSupplyChanges);

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

const SUPPLY_CHANGES: CollectionSupplyChange[] = [
  { eventId: 'ev-1', changes: { paused: [], resumed: [], removedGames: [] } },
];

const NOW = new Date('2026-11-26T12:00:00Z');
const REMOVED_AT = new Date('2026-11-01T00:00:00Z');

/** The entry as reconcile reads it: its removal and reason, and its number of owned copies (#1231). */
const entryState = (deletedAt: Date | null, owned: number, deleteReason: GameRemovalReason | null = null) => ({
  deleteReason,
  deletedAt,
  _count: { copies: owned },
});

describe('CollectionWriteService', () => {
  let service: CollectionWriteService;
  let db: MockDatabaseService;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [CollectionWriteService, { provide: EventEmitter2, useValue: eventEmitter }],
    });

    db = ctx.db;
    unwrapTransaction(db);
    syncSupply.mockResolvedValue([]);
    db.gameCollection.update.mockResolvedValue({ id: 'gc-1' } as GameCollection);
    db.collectionCopy.findFirst.mockResolvedValue(null);
    service = ctx.module.get(CollectionWriteService);
  });

  afterEach(() => jest.clearAllMocks());

  /** Records a callback transaction's start and commit in `order`, running it against the mock (#1221). */
  function recordTransaction(order: string[]): void {
    db.$transaction.mockImplementation((async (operations: unknown) => {
      order.push('begin');
      const result = await (operations as (tx: MockDatabaseService) => Promise<unknown>)(db);
      order.push('commit');

      return result;
    }) as never);
  }

  describe('reconcileOwnership (#1231)', () => {
    // The entry's removal is a summary of its copies: removed with its last
    // owned copy, with that copy's reason. A copy taken back is not a
    // removal, so its reason never names the entry's.
    it('removes a live entry that owns no copy, with the reason of the copy removed now, and answers it removed', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 0) as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Traded } as never);

      await expect(service.reconcileOwnership(asTx(db), 'gc-1', NOW)).resolves.toEqual({ id: 'gc-1', deletedAt: NOW });

      expect(db.gameCollection.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'gc-1' },
        select: {
          deleteReason: true,
          deletedAt: true,
          _count: { select: { copies: { where: { removedAt: null, retractedAt: null } } } },
        },
      });
      // The entry is removed at NOW, so the copy removed at NOW names its reason.
      expect(db.collectionCopy.findFirst).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', removedAt: NOW, AND: { removedAt: { not: null }, retractedAt: null } },
        orderBy: [{ removedAt: 'desc' }, { createdAt: 'desc' }],
        select: { removeReason: true },
      });
      expect(db.gameCollection.update).toHaveBeenCalledWith({
        where: { id: 'gc-1' },
        data: { deletedAt: NOW, deleteReason: GameRemovalReason.Traded, lastUpdated: NOW },
        select: { id: true },
      });
    });

    it('removes it with no reason when no removed copy gave one', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 0) as never);

      await service.reconcileOwnership(asTx(db), 'gc-1', NOW);

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({
        deletedAt: NOW,
        deleteReason: null,
        lastUpdated: NOW,
      });
    });

    // An entry removal's own reason names the entry's removal, an explicit
    // null as much as a reason, so a copy removal stamped later meanwhile
    // can't lend it another (#1231).
    it.each([
      ['a reason', GameRemovalReason.Sold],
      ['null', null],
    ])('removes it with the reason the entry removal gave, %s, and reads no copy for one', async (_, reason) => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 0) as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Traded } as never);

      await service.reconcileOwnership(asTx(db), 'gc-1', NOW, reason);

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({
        deletedAt: NOW,
        deleteReason: reason,
        lastUpdated: NOW,
      });
      expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();
    });

    it('clears the removal of an entry that owns a copy again, and answers it live', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(REMOVED_AT, 1) as never);

      await expect(service.reconcileOwnership(asTx(db), 'gc-1', NOW)).resolves.toEqual({ id: 'gc-1', deletedAt: null });

      expect(db.gameCollection.update).toHaveBeenCalledWith({
        where: { id: 'gc-1' },
        data: { deletedAt: null, deleteReason: null, lastUpdated: NOW },
        select: { id: true },
      });
      expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();
    });

    // Every write through the runner bumps the entry's `lastUpdated`, and so
    // its `updatedAt`, so the `updatedSince` catch-up resends the row when a
    // copy changes, though ownership did not flip.
    it('answers null for a live entry that owns a copy, and still bumps lastUpdated', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 2) as never);

      await expect(service.reconcileOwnership(asTx(db), 'gc-1', NOW)).resolves.toBeNull();

      expect(db.gameCollection.update).toHaveBeenCalledWith({
        where: { id: 'gc-1' },
        data: { lastUpdated: NOW },
        select: { id: true },
      });
    });

    // The entry's reason is a summary of its copies, so a corrected reason on
    // the copy that removed it reaches it, though the entry doesn't flip (#1231).
    it("reads a removed entry's reason again from the copy that removed it, and answers null", async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(REMOVED_AT, 0) as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Stolen } as never);

      await expect(service.reconcileOwnership(asTx(db), 'gc-1', NOW)).resolves.toBeNull();

      expect(db.gameCollection.update).toHaveBeenCalledWith({
        where: { id: 'gc-1' },
        data: { deleteReason: GameRemovalReason.Stolen, lastUpdated: NOW },
        select: { id: true },
      });
    });

    // A correction of the reason of any copy removed with the entry gives
    // the entry that reason, not only one of the newest copy (#1231).
    it('gives a removed entry the reason the write gives, and reads no copy', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(REMOVED_AT, 0, GameRemovalReason.Sold) as never);

      await expect(service.reconcileOwnership(asTx(db), 'gc-1', NOW, GameRemovalReason.Gifted)).resolves.toBeNull();

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({
        deleteReason: GameRemovalReason.Gifted,
        lastUpdated: NOW,
      });
      expect(db.collectionCopy.count).not.toHaveBeenCalled();
      expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();
    });

    // Copies A and B were removed with the entry as Sold, and A's reason was
    // corrected to Gifted, which the entry took. An edit of B that gives no
    // reason must not hand the entry B's Sold back (#1231).
    it("keeps a removed entry's reason while a copy removed with it still carries it", async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(
        entryState(REMOVED_AT, 0, GameRemovalReason.Gifted) as never,
      );
      db.collectionCopy.count.mockResolvedValue(1);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Sold } as never);

      await service.reconcileOwnership(asTx(db), 'gc-1', NOW);

      expect(db.collectionCopy.count).toHaveBeenCalledWith({
        where: {
          entryId: 'gc-1',
          removedAt: REMOVED_AT,
          removeReason: GameRemovalReason.Gifted,
          AND: { removedAt: { not: null }, retractedAt: null },
        },
      });
      expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();
      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({
        deleteReason: GameRemovalReason.Gifted,
        lastUpdated: NOW,
      });
    });

    it('reads the reason again when no copy removed with the entry carries its reason any more', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(
        entryState(REMOVED_AT, 0, GameRemovalReason.Gifted) as never,
      );
      db.collectionCopy.count.mockResolvedValue(0);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Sold } as never);

      await service.reconcileOwnership(asTx(db), 'gc-1', NOW);

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({
        deleteReason: GameRemovalReason.Sold,
        lastUpdated: NOW,
      });
    });
  });

  /**
   * #1231. The flip and the re-read take the entry's reason from one
   * definition: the copy removed at the entry's `deletedAt`, which every
   * removal stamps from the same instant. A copy removal that raced the
   * entry's and committed a later `removedAt` while it waited for the lock is
   * not the one that removed the entry, so it lends the entry no reason.
   */
  describe("the entry's removal reason after a race (#1231)", () => {
    it("re-reads the reason of the copy removed at the entry's deletedAt, not the copy removed last", async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(REMOVED_AT, 0) as never);
      db.collectionCopy.findFirst.mockImplementation((async (args: { where: { removedAt?: unknown } }) =>
        // The copy removed at the entry's instant, or one a racing removal
        // stamped later, which a "latest first" read alone would pick.
        args.where.removedAt === REMOVED_AT
          ? { removeReason: GameRemovalReason.Sold }
          : { removeReason: GameRemovalReason.Lost }) as never);

      await service.reconcileOwnership(asTx(db), 'gc-1', NOW);

      expect(db.collectionCopy.findFirst).toHaveBeenCalledTimes(1);
      expect(db.collectionCopy.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({ removedAt: REMOVED_AT });
      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({
        deleteReason: GameRemovalReason.Sold,
        lastUpdated: NOW,
      });
    });

    // An entry removed before copies existed, or by a write that stamped
    // them apart, has no copy removed at its instant: the copy removed last
    // stands in.
    it('falls back to the copy removed last when none was removed at deletedAt', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(REMOVED_AT, 0) as never);
      db.collectionCopy.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ removeReason: GameRemovalReason.Traded } as never);

      await service.reconcileOwnership(asTx(db), 'gc-1', NOW);

      expect(db.collectionCopy.findFirst).toHaveBeenNthCalledWith(2, {
        where: { entryId: 'gc-1', AND: { removedAt: { not: null }, retractedAt: null } },
        orderBy: [{ removedAt: 'desc' }, { createdAt: 'desc' }],
        select: { removeReason: true },
      });
      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({
        deleteReason: GameRemovalReason.Traded,
        lastUpdated: NOW,
      });
    });
  });

  describe('lockEntry (#1231)', () => {
    it("locks the entry's row FOR UPDATE by id, and answers its owner, platform game, medium and removal", async () => {
      const locked = { deletedAt: null, medium: GameMedium.Physical, platformGameId: 'pg-1', userId: 'user-1' };
      db.$queryRaw.mockResolvedValue([locked] as never);

      await expect(service.lockEntry(asTx(db), 'gc-1')).resolves.toEqual(locked);

      const [query] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
      expect(rawQueryText(query)).toBe(
        'SELECT deleted_at AS "deletedAt", medium, platform_game_id AS "platformGameId", user_id AS "userId" FROM game_collections WHERE id = ? FOR UPDATE',
      );
      expect(query.values).toEqual(['gc-1']);
    });

    it('answers null for an entry that does not exist', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.lockEntry(asTx(db), 'gc-404')).resolves.toBeNull();
    });

    // Given its owner, the lock names them, so another user's entry is never
    // locked (#1231).
    it("locks only the given owner's entry", async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.lockEntry(asTx(db), 'gc-1', 'user-2')).resolves.toBeNull();

      const [query] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
      expect(rawQueryText(query)).toMatch(/WHERE id = \? AND user_id = \? FOR UPDATE$/);
      expect(query.values).toEqual(['gc-1', 'user-2']);
    });
  });

  describe('lockEntryUnder (#1231)', () => {
    const COND = { userId: 'user-1' };
    const abilityService = { getCurrentResourceConditions: jest.fn(() => [COND]) };
    const LOCKED = { deletedAt: null, medium: GameMedium.Physical, platformGameId: 'pg-1', userId: 'user-1' };

    it("reads the entry under the action's conditions, then locks it", async () => {
      db.gameCollection.findFirst.mockResolvedValue({ id: 'gc-1' } as never);
      db.$queryRaw.mockResolvedValue([LOCKED] as never);

      await expect(service.lockEntryUnder(asTx(db), abilityService, 'gc-1', Action.delete)).resolves.toEqual(LOCKED);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.delete,
      );
      expect(db.gameCollection.findFirst).toHaveBeenCalledWith({
        where: { id: 'gc-1', AND: [COND] },
        select: { id: true },
      });
      expect(db.gameCollection.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        db.$queryRaw.mock.invocationCallOrder[0] ?? 0,
      );
    });

    // A request for an entry the actor may not write locks nothing, so it
    // can't make the owner's writes wait behind it.
    it('answers COLLECTION_ENTRY_NOT_FOUND for an entry outside the conditions, and locks nothing', async () => {
      db.gameCollection.findFirst.mockResolvedValue(null);

      await expect(service.lockEntryUnder(asTx(db), abilityService, 'gc-1', Action.update)).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('answers COLLECTION_ENTRY_NOT_FOUND for an entry gone before the lock', async () => {
      db.gameCollection.findFirst.mockResolvedValue({ id: 'gc-1' } as never);
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.lockEntryUnder(asTx(db), abilityService, 'gc-1', Action.update)).rejects.toMatchObject({
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
    });
  });

  describe('run (#1221, #1231)', () => {
    // The write, the reconcile and the sync share one transaction, so a
    // flip and the offers it pauses or resumes commit together. The emit
    // waits for the commit, so no listener hears of a change that rolled
    // back. The transaction keeps the default isolation, READ COMMITTED:
    // the sync relies on each of its statements reading what had committed
    // when it started.
    it('reconciles after the write and syncs a flip in the same transaction, then emits once it commits', async () => {
      const order: string[] = [];
      recordTransaction(order);
      db.gameCollection.findUniqueOrThrow.mockImplementation((async () => {
        order.push('reconcile');
        return entryState(null, 0);
      }) as never);
      syncSupply.mockImplementation(async () => {
        order.push('sync');
        return SUPPLY_CHANGES;
      });
      emitSupply.mockImplementation(() => {
        order.push('emit');
      });

      const result = await service.run(
        async () => {
          order.push('write');
          return { result: 'the copy', entryId: 'gc-1' };
        },
        'user-1',
        NOW,
      );

      expect(result).toBe('the copy');
      expect(order).toEqual(['begin', 'write', 'reconcile', 'sync', 'commit', 'emit']);
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: NOW }, NOW);
      expect(emitSupply).toHaveBeenCalledWith(eventEmitter, SUPPLY_CHANGES, 'user-1', NOW);
      expect(db.$transaction.mock.calls[0]).toHaveLength(1);
    });

    it('runs no sync and emits nothing when ownership did not flip', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 1) as never);

      await service.run(async () => ({ result: null, entryId: 'gc-1' }), 'user-1', NOW);

      expect(syncSupply).not.toHaveBeenCalled();
      expect(emitSupply).not.toHaveBeenCalled();
    });

    it('reconciles, syncs and emits nothing when the write fails', async () => {
      const refused = new Error('refused');

      await expect(service.run(async () => Promise.reject(refused), 'user-1', NOW)).rejects.toBe(refused);

      expect(db.gameCollection.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(syncSupply).not.toHaveBeenCalled();
      expect(emitSupply).not.toHaveBeenCalled();
    });

    it('emits the changes as nobody’s for an actor with no user (#1221)', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(REMOVED_AT, 1) as never);
      syncSupply.mockResolvedValue(SUPPLY_CHANGES);

      await service.run(async () => ({ result: null, entryId: 'gc-1' }), null, NOW);

      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: null }, NOW);
      expect(emitSupply).toHaveBeenCalledWith(eventEmitter, SUPPLY_CHANGES, null, NOW);
    });
  });

  describe('runForRow (#1231)', () => {
    // An entry route answers the row as the transaction leaves it: the
    // removal or acquisition its write caused is written by the reconcile,
    // after the write, so the row is read after that, in the same
    // transaction, still under the entry's lock.
    it('answers what `read` reads of the entry after the reconcile and the sync, in the same transaction', async () => {
      const order: string[] = [];
      recordTransaction(order);
      const row = { id: 'gc-1', deletedAt: NOW };
      db.gameCollection.findUniqueOrThrow.mockImplementation((async () => {
        order.push('reconcile');
        return entryState(null, 0);
      }) as never);
      syncSupply.mockImplementation(async () => {
        order.push('sync');
        return [];
      });
      const read = jest.fn(async () => {
        order.push('read');
        return row;
      });

      await expect(
        service.runForRow(
          async () => {
            order.push('write');
            return 'gc-1';
          },
          read,
          'user-1',
          NOW,
        ),
      ).resolves.toBe(row);

      expect(order).toEqual(['begin', 'write', 'reconcile', 'sync', 'read', 'commit']);
      expect(read).toHaveBeenCalledWith(db, 'gc-1');
    });

    // A copy removal names its own reason, so a removal stamped later by a
    // racing request can't lend the entry another (#1231).
    it("run hands the reconcile the copy removal's reason (#1231)", async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 0) as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Traded } as never);

      await service.run(async () => ({ entryId: 'gc-1', result: null }), 'user-1', NOW, GameRemovalReason.Lost);

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toMatchObject({
        deletedAt: NOW,
        deleteReason: GameRemovalReason.Lost,
      });
      expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();
    });

    // A restore learns the reason it may remove the entry with only once it
    // has read the revision under the entry's lock, so the write names it in
    // its answer, and that wins over `run`'s (#1231).
    it('hands the reconcile the reason the write names under the lock (#1231)', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 0) as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Lost } as never);

      await service.run(
        async () => ({ entryId: 'gc-1', result: null, removeReason: GameRemovalReason.Traded }),
        'user-1',
        NOW,
      );

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toMatchObject({
        deletedAt: NOW,
        deleteReason: GameRemovalReason.Traded,
      });
      expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();
    });

    it("hands the reconcile the entry removal's reason (#1231)", async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 0) as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Traded } as never);

      await service.runForRow(
        async () => 'gc-1',
        async () => null,
        'user-1',
        NOW,
        GameRemovalReason.Lost,
      );

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toMatchObject({
        deletedAt: NOW,
        deleteReason: GameRemovalReason.Lost,
      });
    });
  });
});
