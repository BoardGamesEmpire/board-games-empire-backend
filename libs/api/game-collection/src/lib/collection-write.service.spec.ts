import type { GameCollection, Prisma } from '@bge/database';
import { GameMedium, GameRemovalReason } from '@bge/database';
import type { CollectionSupplyChange } from '@bge/event';
import { emitCollectionSupplyChanges, syncCollectionEntrySupply } from '@bge/event';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, rawQueryText, unwrapTransaction } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { COLLECTION_INCLUDE } from './collection-row';
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

/** The entry as reconcile reads it: its removal, and its number of owned copies (#1231). */
const entryState = (deletedAt: Date | null, owned: number) => ({ deletedAt, _count: { copies: owned } });

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
    it('removes a live entry that owns no copy, with the reason of the copy removed last, and answers it removed', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 0) as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Traded } as never);

      await expect(service.reconcileOwnership(asTx(db), 'gc-1', NOW)).resolves.toEqual({ id: 'gc-1', deletedAt: NOW });

      expect(db.gameCollection.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'gc-1' },
        select: { deletedAt: true, _count: { select: { copies: { where: { removedAt: null, retractedAt: null } } } } },
      });
      expect(db.collectionCopy.findFirst).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', removedAt: { not: null }, retractedAt: null },
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
    it.each([
      ['a live entry that owns a copy', null, 2],
      ['a removed entry that owns none', REMOVED_AT, 0],
    ])('answers null for %s, and still bumps lastUpdated', async (_, deletedAt, owned) => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(deletedAt, owned) as never);

      await expect(service.reconcileOwnership(asTx(db), 'gc-1', NOW)).resolves.toBeNull();

      expect(db.gameCollection.update).toHaveBeenCalledWith({
        where: { id: 'gc-1' },
        data: { lastUpdated: NOW },
        select: { id: true },
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
    // transaction.
    it('answers the entry read after the reconcile and the sync, in the same transaction', async () => {
      const order: string[] = [];
      recordTransaction(order);
      const row = { id: 'gc-1', deletedAt: NOW };
      db.gameCollection.findUniqueOrThrow.mockImplementation((async (args: { include?: unknown }) => {
        order.push(args.include === undefined ? 'reconcile' : 'read');
        return args.include === undefined ? entryState(null, 0) : row;
      }) as never);
      syncSupply.mockImplementation(async () => {
        order.push('sync');
        return [];
      });

      await expect(
        service.runForRow(
          async () => {
            order.push('write');
            return 'gc-1';
          },
          'user-1',
          NOW,
        ),
      ).resolves.toBe(row);

      expect(order).toEqual(['begin', 'write', 'reconcile', 'sync', 'read', 'commit']);
      expect(db.gameCollection.findUniqueOrThrow).toHaveBeenLastCalledWith({
        where: { id: 'gc-1' },
        include: COLLECTION_INCLUDE,
      });
    });

    it("hands the reconcile the entry removal's reason (#1231)", async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue(entryState(null, 0) as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Traded } as never);

      await service.runForRow(async () => 'gc-1', 'user-1', NOW, GameRemovalReason.Lost);

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toMatchObject({
        deletedAt: NOW,
        deleteReason: GameRemovalReason.Lost,
      });
    });
  });
});
