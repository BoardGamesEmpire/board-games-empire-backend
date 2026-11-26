import type { CollectionCopy, GameCollection, GameRelease } from '@bge/database';
import {
  Action,
  DatePrecision,
  GameCondition,
  GameMedium,
  GameRemovalReason,
  Prisma,
  ResourceType,
} from '@bge/database';
import { foreignKeyViolation, uniqueViolation } from '@bge/database/testing';
import { syncCollectionEntrySupply } from '@bge/event';
import { AbilityService } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, rawQueryText, unwrapTransaction } from '@bge/testing';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CollectionCopyService } from './collection-copy.service';
import type { CopyRevisionValues } from './collection-revisions';
import { COPY_REVISION_SELECT, copyRevisionValues } from './collection-revisions';
import { OWNER_COPY_SELECT } from './collection-row';
import { CollectionWriteService } from './collection-write.service';

// The supply sync has its own spec in `@bge/event`; here it is a seam (#1221).
jest.mock('@bge/event', () => ({
  syncCollectionEntrySupply: jest.fn(),
  emitCollectionSupplyChanges: jest.fn(),
}));

const syncSupply = jest.mocked(syncCollectionEntrySupply);

const COND = { id: 'sentinel-condition' };
const ME = 'user-1';

/** The entry's row as `lockEntry` answers it (#1231). */
const LOCKED = { deletedAt: null, medium: GameMedium.Physical, platformGameId: 'pg-1', userId: ME };

/** A copy row as `OWNER_COPY_SELECT` reads it: nothing known, unless given (#1231). */
const copyRow = (overrides: Partial<CollectionCopy> & { release?: unknown } = {}) => ({
  id: 'copy-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  condition: null,
  acquiredOn: null,
  acquiredOnPrecision: null,
  acquiredFrom: null,
  pricePaidAmount: null,
  pricePaidCurrency: null,
  currentValueAmount: null,
  currentValueCurrency: null,
  note: null,
  removedAt: null,
  removedOn: null,
  removedOnPrecision: null,
  removeReason: null,
  release: null,
  releaseId: null,
  ...overrides,
});

/**
 * A revision's stored values (#1231): an owned copy nothing is known about,
 * unless given, as `copyRevisionValues` writes them.
 */
const storedValues = (overrides: Partial<CopyRevisionValues> = {}): CopyRevisionValues => ({
  releaseId: null,
  condition: null,
  acquiredOn: null,
  acquiredOnPrecision: null,
  acquiredFrom: null,
  pricePaidAmount: null,
  pricePaidCurrency: null,
  currentValueAmount: null,
  currentValueCurrency: null,
  note: null,
  removedAt: null,
  removedOn: null,
  removedOnPrecision: null,
  removeReason: null,
  ...overrides,
});

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Dependent record not found', { code: 'P2025', clientVersion: 'test' });

describe('CollectionCopyService (#1231)', () => {
  let service: CollectionCopyService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<AbilityService, 'assertCurrentActorCan' | 'getActingUserId' | 'getCurrentResourceConditions'>
  >;

  beforeEach(async () => {
    abilityService = {
      // Allows, unless a spec says otherwise (#1288).
      assertCurrentActorCan: jest.fn(),
      getActingUserId: jest.fn().mockReturnValue(ME),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        CollectionCopyService,
        // The REAL write runner, over the mocked database, so each write
        // reconciles the entry's ownership as it does in the api (#1231).
        CollectionWriteService,
        { provide: AbilityService, useValue: abilityService },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    });

    db = ctx.db;
    unwrapTransaction(db);
    syncSupply.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([LOCKED] as never);
    db.gameCollection.update.mockResolvedValue({ id: 'gc-1' } as GameCollection);
    // The reconcile reads the entry live with an owned copy, unless a spec says otherwise.
    db.gameCollection.findUniqueOrThrow.mockResolvedValue({ deletedAt: null, _count: { copies: 1 } } as never);
    db.collectionCopy.findFirst.mockResolvedValue(null);
    db.collectionCopy.count.mockResolvedValue(1);
    db.collectionCopy.create.mockResolvedValue(copyRow() as never);
    db.collectionCopy.update.mockResolvedValue(copyRow() as never);
    db.collectionCopy.findUnique.mockResolvedValue(copyRow() as never);
    db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameRelease);
    db.collectionCopyRevision.findUnique.mockResolvedValue({ values: storedValues() } as never);
    service = ctx.module.get(CollectionCopyService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Restores the Logger spies some specs make; the module mocks stay.
    jest.restoreAllMocks();
  });

  /**
   * Each write's first statement locks the entry's row, so it takes turns
   * with nominations naming the entry (#1221); then the entry is held to the
   * actor's update conditions (#1288).
   */
  function expectLockedThenChecked(): void {
    const [lock] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
    expect(rawQueryText(lock)).toMatch(/FROM game_collections WHERE id = \? AND user_id = \? FOR UPDATE$/);
    expect(lock.values).toEqual(['gc-1', ME]);
    expect(db.gameCollection.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'gc-1', AND: [COND] },
      data: { lastUpdated: expect.any(Date) },
      select: { id: true },
    });
    // Both are delegates of one mock database service, so their call orders
    // come from one counter and compare.
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.gameCollection.update.mock.invocationCallOrder[0] ?? 0,
    );
    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.GameCollection,
      Action.update,
    );
  }

  describe('list', () => {
    // A copy's acquisition and price are the entry owner's alone, whatever the
    // entry's reach, so the entry is read as the acting user's own (#1231).
    it("reads the acting user's own entry under the read conditions, every copy oldest first", async () => {
      db.gameCollection.findUnique.mockResolvedValue({
        copies: [
          copyRow({ acquiredOn: new Date('2019-03-01T00:00:00Z'), acquiredOnPrecision: DatePrecision.Month }),
          copyRow({
            id: 'copy-2',
            pricePaidAmount: 1250,
            pricePaidCurrency: 'EUR',
            removedAt: new Date('2026-02-01T00:00:00Z'),
            removedOn: new Date('2026-01-01T00:00:00Z'),
            removedOnPrecision: DatePrecision.Year,
            removeReason: GameRemovalReason.Sold,
          }),
        ],
      } as never);

      const copies = await service.list('gc-1');

      expect(db.gameCollection.findUnique).toHaveBeenCalledWith({
        where: { id: 'gc-1', userId: ME, AND: [COND] },
        select: { copies: { select: OWNER_COPY_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      });
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.read,
      );
      expect(copies).toEqual([
        expect.objectContaining({ id: 'copy-1', acquiredOn: '2019-03', pricePaid: null, removedOn: null }),
        expect.objectContaining({
          id: 'copy-2',
          pricePaid: { amount: 1250, currency: 'EUR' },
          removedOn: '2026',
          removeReason: GameRemovalReason.Sold,
        }),
      ]);
    });

    it("answers COLLECTION_ENTRY_NOT_FOUND for an entry that isn't the actor's", async () => {
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.list('gc-1')).rejects.toMatchObject({ status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
    });

    // A plugin or system actor has no collection of its own (#1231).
    it('answers COLLECTION_ENTRY_NOT_FOUND to an actor that is no user, and reads nothing', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.list('gc-1')).rejects.toMatchObject({ status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
      expect(db.gameCollection.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('add', () => {
    it('locks the entry, holds it to its update conditions, checks the room, then creates the copy', async () => {
      db.collectionCopy.create.mockResolvedValue(copyRow({ id: 'copy-2', note: 'Deluxe' }) as never);

      const added = await service.add('gc-1', { note: 'Deluxe', releaseId: 'rel-1' });

      expectLockedThenChecked();
      expect(db.collectionCopy.count).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
      });
      expect(db.gameRelease.findUnique).toHaveBeenCalledWith({
        where: { id: 'rel-1' },
        select: { platformGameId: true },
      });
      expect(db.collectionCopy.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ entryId: 'gc-1', note: 'Deluxe', releaseId: 'rel-1', condition: null }),
        select: OWNER_COPY_SELECT,
      });
      expect(added).toMatchObject({ id: 'copy-2', note: 'Deluxe' });
    });

    it('answers COLLECTION_ENTRY_NOT_FOUND for an entry that does not exist, and writes nothing', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.add('gc-1', {})).rejects.toMatchObject({ code: 'COLLECTION_ENTRY_NOT_FOUND' });
      expect(db.gameCollection.update).not.toHaveBeenCalled();
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
    });

    // An entry outside the update conditions, another user's, is no entry
    // this actor may add a copy to (#1288).
    it('answers COLLECTION_ENTRY_NOT_FOUND for an entry outside the update conditions, and adds no copy', async () => {
      db.gameCollection.update.mockRejectedValueOnce(dependentRecordNotFound());

      await expect(service.add('gc-1', {})).rejects.toMatchObject({ code: 'COLLECTION_ENTRY_NOT_FOUND' });
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
    });

    it('refuses the copy past the limit with COLLECTION_COPY_LIMIT_REACHED, and adds none', async () => {
      db.collectionCopy.count.mockResolvedValue(100);

      await expect(service.add('gc-1', {})).rejects.toMatchObject({
        status: 409,
        code: 'COLLECTION_COPY_LIMIT_REACHED',
      });
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
    });

    it("refuses a condition on a digital entry's copy with COLLECTION_CONDITION_DIGITAL", async () => {
      db.$queryRaw.mockResolvedValue([{ ...LOCKED, medium: GameMedium.Digital }] as never);

      await expect(service.add('gc-1', { condition: GameCondition.Good })).rejects.toMatchObject({
        code: 'COLLECTION_CONDITION_DIGITAL',
      });
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
    });

    // A copy added to a removed entry acquires it again: the reconcile
    // clears its removal and the sync resumes its offers (#1231, #1221).
    it('acquires a removed entry again', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue({
        deletedAt: new Date('2026-01-01'),
        _count: { copies: 1 },
      } as never);

      await service.add('gc-1', {});

      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: null }, expect.any(Date));
    });
  });

  /**
   * #1231, ADR 0002. A client queues the add offline and may send it again,
   * so it carries a `clientRequestId`: a repeat answers the copy the key
   * made, as it stands now, whatever the repeat says. The lookup runs under
   * the entry's lock, after the entry is found to be the actor's own and
   * within their update conditions, so a key is no way past those checks.
   */
  describe('add with a clientRequestId', () => {
    const KEY = 'key-1';
    const byKey = {
      where: { entryId_clientRequestId: { entryId: 'gc-1', clientRequestId: KEY } },
      select: OWNER_COPY_SELECT,
    };

    beforeEach(() => {
      db.collectionCopy.findUnique.mockResolvedValue(null);
      db.collectionCopy.create.mockResolvedValue(copyRow({ id: 'copy-2' }) as never);
    });

    it('stores the key on the copy it adds', async () => {
      await service.add('gc-1', { note: 'Deluxe', clientRequestId: KEY });

      expectLockedThenChecked();
      expect(db.collectionCopy.findUnique).toHaveBeenCalledWith(byKey);
      expect(db.collectionCopy.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ entryId: 'gc-1', note: 'Deluxe', clientRequestId: KEY }),
        select: OWNER_COPY_SELECT,
      });
    });

    // A repeat answers the original, removed since included, and adds
    // nothing, so it never meets the cap, whatever its own body says.
    it('a repeat answers the copy the key made, as it stands, and adds none, even at the cap', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(
        copyRow({
          id: 'copy-2',
          note: 'Deluxe',
          removedAt: new Date('2026-11-20T00:00:00Z'),
          removedOn: new Date('2026-11-20T00:00:00Z'),
          removedOnPrecision: DatePrecision.Day,
        }) as never,
      );
      db.collectionCopy.count.mockResolvedValue(100);

      const replayed = await service.add('gc-1', { note: 'Something else', clientRequestId: KEY });

      expectLockedThenChecked();
      expect(replayed).toMatchObject({ id: 'copy-2', note: 'Deluxe', removedOn: '2026-11-20' });
      expect(db.collectionCopy.count).not.toHaveBeenCalled();
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
      expect(db.gameRelease.findUnique).not.toHaveBeenCalled();
    });

    // Two repeats take the entry's lock in turn, so the second finds the
    // first's copy. Should one still trip the key's unique, its transaction
    // is aborted, so the add runs once more and finds the copy the other
    // committed, as `createOrReplay` does.
    it("a concurrent repeat that trips the key's unique finds the other's copy", async () => {
      db.collectionCopy.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(copyRow({ id: 'copy-other' }) as never);
      db.collectionCopy.create.mockRejectedValueOnce(
        uniqueViolation({ index: 'collection_copy_entry_client_request_id_unique' }),
      );

      const added = await service.add('gc-1', { clientRequestId: KEY });

      expect(added).toMatchObject({ id: 'copy-other' });
      expect(db.$transaction).toHaveBeenCalledTimes(2);
      expect(db.collectionCopy.create).toHaveBeenCalledTimes(1);
      expect(db.collectionCopy.findUnique).toHaveBeenNthCalledWith(2, byKey);
    });

    it('rethrows a unique violation of an add with no key, and runs it once', async () => {
      const violation = uniqueViolation({ index: 'collection_copy_entry_client_request_id_unique' });
      db.collectionCopy.create.mockRejectedValue(violation);

      await expect(service.add('gc-1', {})).rejects.toBe(violation);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    it("rethrows a keyed add's violation of another unique, and runs it once", async () => {
      const violation = uniqueViolation({ index: 'collection_copies_upstream_account_id_upstream_key_key' });
      db.collectionCopy.create.mockRejectedValue(violation);

      await expect(service.add('gc-1', { clientRequestId: KEY })).rejects.toBe(violation);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('refuses an edit that names no field', async () => {
      await expect(service.update('gc-1', 'copy-1', {})).rejects.toThrow(BadRequestException);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    // Every user edit stamps the copy, so a sync never undoes it (#1231).
    it('writes only the fields given, and stamps the copy as edited by the user', async () => {
      db.collectionCopy.update.mockResolvedValue(copyRow({ note: 'Sleeved' }) as never);

      const edited = await service.update('gc-1', 'copy-1', { note: 'Sleeved', pricePaid: null });

      expectLockedThenChecked();
      // A taken-back copy never existed, so it takes no edit (#1231).
      expect(db.collectionCopy.findUnique).toHaveBeenCalledWith({
        where: { id: 'copy-1', entryId: 'gc-1', retractedAt: null },
        select: expect.any(Object),
      });
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionCopy.update).toHaveBeenCalledWith({
        where: { id: 'copy-1' },
        data: { note: 'Sleeved', pricePaidAmount: null, pricePaidCurrency: null, editedByUserAt: now },
        select: OWNER_COPY_SELECT,
      });
      expect(edited).toMatchObject({ id: 'copy-1', note: 'Sleeved' });
    });

    it('answers COLLECTION_COPY_NOT_FOUND for a copy the entry does not hold', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(null);

      await expect(service.update('gc-1', 'copy-9', { note: 'x' })).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_COPY_NOT_FOUND',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    // The release is read without a lock, so it can go before the edit
    // writes it; the copy's trigger then fails, and the edit answers the 404
    // of a release never there (#1231).
    it('answers GAME_RELEASE_NOT_FOUND for a release gone before the edit wrote it', async () => {
      db.collectionCopy.update.mockRejectedValue(foreignKeyViolation({ index: 'collection_copies_release_match' }));

      await expect(service.update('gc-1', 'copy-1', { releaseId: 'rel-1' })).rejects.toMatchObject({
        status: 404,
        code: 'GAME_RELEASE_NOT_FOUND',
      });
    });

    it('answers COLLECTION_ENTRY_NOT_FOUND for an entry outside the update conditions', async () => {
      db.gameCollection.update.mockRejectedValueOnce(dependentRecordNotFound());

      await expect(service.update('gc-1', 'copy-1', { note: 'x' })).rejects.toMatchObject({
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    it.each([
      ['removedOn', { removedOn: '2024' }],
      ['removeReason', { removeReason: GameRemovalReason.Lost }],
    ])('refuses %s on a copy not removed with COLLECTION_COPY_NOT_REMOVED', async (_, dto) => {
      await expect(service.update('gc-1', 'copy-1', dto)).rejects.toMatchObject({
        status: 409,
        code: 'COLLECTION_COPY_NOT_REMOVED',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    describe('a removed copy', () => {
      beforeEach(() => {
        db.collectionCopy.findUnique.mockResolvedValue(
          copyRow({
            acquiredOn: new Date('2020-05-01T00:00:00Z'),
            acquiredOnPrecision: DatePrecision.Month,
            removedAt: new Date('2024-07-01T00:00:00Z'),
            removedOn: new Date('2024-06-01T00:00:00Z'),
            removedOnPrecision: DatePrecision.Month,
            removeReason: GameRemovalReason.Sold,
          }) as never,
        );
      });

      // The entry's reason is a summary of its copies, so correcting the
      // reason of a copy removed with the entry corrects the entry's too,
      // whichever of the copies removed with it that is: the correction hands
      // the reason over, rather than the newest copy's being read back (#1231).
      it("a corrected removal reason of a copy removed with the entry becomes the entry's reason (#1231)", async () => {
        db.$queryRaw.mockResolvedValue([{ ...LOCKED, deletedAt: new Date('2024-07-01T00:00:00Z') }] as never);
        db.gameCollection.findUniqueOrThrow.mockResolvedValue({
          deleteReason: GameRemovalReason.Sold,
          deletedAt: new Date('2024-07-01T00:00:00Z'),
          _count: { copies: 0 },
        } as never);
        // Another copy removed with the entry, created later, still says Sold.
        db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Sold } as never);

        await service.update('gc-1', 'copy-1', { removeReason: GameRemovalReason.Stolen });

        expect(db.gameCollection.update).toHaveBeenLastCalledWith({
          where: { id: 'gc-1' },
          data: { deleteReason: GameRemovalReason.Stolen, lastUpdated: expect.any(Date) },
          select: { id: true },
        });
        expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();
        expect(syncSupply).not.toHaveBeenCalled();
      });

      // A copy removed before the entry was is not the entry's removal, so
      // its corrected reason hands the entry nothing; the entry keeps its
      // reason while a copy removed with it still carries it (#1231).
      it("a corrected removal reason of a copy removed earlier leaves the entry's reason (#1231)", async () => {
        db.$queryRaw.mockResolvedValue([{ ...LOCKED, deletedAt: new Date('2025-01-01T00:00:00Z') }] as never);
        db.gameCollection.findUniqueOrThrow.mockResolvedValue({
          deleteReason: GameRemovalReason.Traded,
          deletedAt: new Date('2025-01-01T00:00:00Z'),
          _count: { copies: 0 },
        } as never);
        db.collectionCopy.count.mockResolvedValue(1);

        await service.update('gc-1', 'copy-1', { removeReason: GameRemovalReason.Stolen });

        expect(db.gameCollection.update).toHaveBeenLastCalledWith({
          where: { id: 'gc-1' },
          data: { deleteReason: GameRemovalReason.Traded, lastUpdated: expect.any(Date) },
          select: { id: true },
        });
      });

      it('takes a new removal date and reason', async () => {
        await service.update('gc-1', 'copy-1', { removedOn: '2023-02-03', removeReason: null });

        expect(db.collectionCopy.update.mock.calls[0]?.[0]?.data).toEqual({
          removedOn: new Date('2023-02-03T00:00:00Z'),
          removedOnPrecision: DatePrecision.Day,
          removeReason: null,
          editedByUserAt: expect.any(Date),
        });
      });

      // The order is checked against what the copy will hold: the stored
      // acquisition with a new removal, or a new acquisition with the
      // stored removal (#1231).
      it('refuses a new removal before the stored acquisition with COLLECTION_DATE_ORDER', async () => {
        await expect(service.update('gc-1', 'copy-1', { removedOn: '2020-03' })).rejects.toMatchObject({
          code: 'COLLECTION_DATE_ORDER',
        });
        expect(db.collectionCopy.update).not.toHaveBeenCalled();
      });

      it('refuses a new acquisition after the stored removal with COLLECTION_DATE_ORDER', async () => {
        await expect(service.update('gc-1', 'copy-1', { acquiredOn: '2025' })).rejects.toMatchObject({
          code: 'COLLECTION_DATE_ORDER',
        });
        expect(db.collectionCopy.update).not.toHaveBeenCalled();
      });

      it('takes an acquisition made unknown, whatever the removal', async () => {
        await service.update('gc-1', 'copy-1', { acquiredOn: null });

        expect(db.collectionCopy.update.mock.calls[0]?.[0]?.data).toMatchObject({
          acquiredOn: null,
          acquiredOnPrecision: null,
        });
      });
    });
  });

  describe('remove', () => {
    it('removes an owned copy of the entry, dated and with its reason', async () => {
      db.collectionCopy.count.mockResolvedValue(2);

      await service.remove('gc-1', 'copy-1', { reason: GameRemovalReason.Gifted, removedOn: '2024' });

      expectLockedThenChecked();
      expect(db.collectionCopy.findUnique).toHaveBeenCalledWith({
        where: { id: 'copy-1', entryId: 'gc-1', AND: { removedAt: null, retractedAt: null } },
        select: COPY_REVISION_SELECT,
      });
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionCopy.update).toHaveBeenCalledWith({
        where: { id: 'copy-1' },
        data: {
          removedAt: now,
          removedOn: new Date('2024-01-01T00:00:00Z'),
          removedOnPrecision: DatePrecision.Year,
          removeReason: GameRemovalReason.Gifted,
          // A removal is the user's word on the copy, so a sync leaves it (#1231).
          editedByUserAt: now,
        },
        select: OWNER_COPY_SELECT,
      });
      // Another copy is still owned, so the entry stays, and needs no delete permission.
      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
    });

    it('answers COLLECTION_COPY_NOT_FOUND for a copy missing or already removed', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(null);

      await expect(service.remove('gc-1', 'copy-1', {})).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_COPY_NOT_FOUND',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    // Removing the last owned copy removes the entry, so it needs the
    // entry's delete permission too (#1288).
    it("holds the removal of the last owned copy to the entry's delete permission", async () => {
      await service.remove('gc-1', 'copy-1', {});

      expect(db.collectionCopy.count).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
      });
      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.delete, ResourceType.GameCollection, {
        id: 'gc-1',
        ...LOCKED,
      });
    });

    it('refuses the last owned copy to an actor that may not remove the entry, and removes nothing', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.remove('gc-1', 'copy-1', {})).rejects.toThrow(ForbiddenException);
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    // The entry takes this removal's reason, handed to the reconcile rather
    // than read back from the copies: a racing removal stamped later can't
    // lend it another (#1231).
    it("removes the entry with its last owned copy, with that copy's reason, and syncs its offers", async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue({ deletedAt: null, _count: { copies: 0 } } as never);
      db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Lost } as never);

      await service.remove('gc-1', 'copy-1', { reason: GameRemovalReason.Traded });

      expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();

      expect(db.gameCollection.update).toHaveBeenLastCalledWith({
        where: { id: 'gc-1' },
        data: { deletedAt: expect.any(Date), deleteReason: GameRemovalReason.Traded, lastUpdated: expect.any(Date) },
        select: { id: true },
      });
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: expect.any(Date) }, expect.any(Date));
    });

    // A copy may be acquired on a day that is today east of UTC but tomorrow
    // in UTC (the latest today on Earth), so a removal with no date, dated
    // today in UTC, would end before it began (#1231).
    describe('a removal with no date, with the clock at 23:30 UTC on 2026-11-26', () => {
      const removedOnOf = () => db.collectionCopy.update.mock.calls[0]?.[0]?.data;

      beforeEach(() => {
        jest.useFakeTimers({ now: new Date('2026-11-26T23:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('a removal with no date of a copy acquired later than today in UTC is dated its acquisition day (#1231)', async () => {
        db.collectionCopy.findUnique.mockResolvedValue(
          copyRow({ acquiredOn: new Date('2026-11-27T00:00:00Z'), acquiredOnPrecision: DatePrecision.Day }) as never,
        );

        await service.remove('gc-1', 'copy-1', {});

        expect(removedOnOf()).toMatchObject({
          removedOn: new Date('2026-11-27T00:00:00Z'),
          removedOnPrecision: DatePrecision.Day,
        });
      });

      it('dates the removal at Day precision when a month that has begun in UTC+14 only is the acquisition', async () => {
        jest.setSystemTime(new Date('2026-11-30T23:30:00Z'));
        db.collectionCopy.findUnique.mockResolvedValue(
          copyRow({ acquiredOn: new Date('2026-12-01T00:00:00Z'), acquiredOnPrecision: DatePrecision.Month }) as never,
        );

        await service.remove('gc-1', 'copy-1', {});

        expect(removedOnOf()).toMatchObject({
          removedOn: new Date('2026-12-01T00:00:00Z'),
          removedOnPrecision: DatePrecision.Day,
        });
      });

      it.each([
        ['no acquisition date', null, null],
        ['an earlier acquisition', new Date('2026-11-20T00:00:00Z'), DatePrecision.Day],
        ['a Month acquisition that has begun', new Date('2026-11-01T00:00:00Z'), DatePrecision.Month],
        ['a Year acquisition that has begun', new Date('2026-01-01T00:00:00Z'), DatePrecision.Year],
        ['an acquisition today in UTC', new Date('2026-11-26T00:00:00Z'), DatePrecision.Day],
      ])('dates the removal today in UTC for %s', async (_, acquiredOn, acquiredOnPrecision) => {
        db.collectionCopy.findUnique.mockResolvedValue(copyRow({ acquiredOn, acquiredOnPrecision }) as never);

        await service.remove('gc-1', 'copy-1', {});

        expect(removedOnOf()).toMatchObject({
          removedOn: new Date('2026-11-26T00:00:00Z'),
          removedOnPrecision: DatePrecision.Day,
        });
      });

      it('still refuses a removal date the user sent that ends before the acquisition', async () => {
        db.collectionCopy.findUnique.mockResolvedValue(
          copyRow({ acquiredOn: new Date('2026-11-27T00:00:00Z'), acquiredOnPrecision: DatePrecision.Day }) as never,
        );

        await expect(service.remove('gc-1', 'copy-1', { removedOn: '2026-11-26' })).rejects.toMatchObject({
          code: 'COLLECTION_DATE_ORDER',
        });
        expect(db.collectionCopy.update).not.toHaveBeenCalled();
      });
    });

    it('refuses a removal dated before the copy was acquired with COLLECTION_DATE_ORDER', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(
        copyRow({ acquiredOn: new Date('2020-05-01T00:00:00Z'), acquiredOnPrecision: DatePrecision.Month }) as never,
      );

      await expect(service.remove('gc-1', 'copy-1', { removedOn: '2020-03' })).rejects.toMatchObject({
        code: 'COLLECTION_DATE_ORDER',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    it('refuses a removal dated on a day that is today nowhere yet with COLLECTION_DATE_IN_FUTURE, before any write', async () => {
      await expect(service.remove('gc-1', 'copy-1', { removedOn: '9999' })).rejects.toMatchObject({
        code: 'COLLECTION_DATE_IN_FUTURE',
      });
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  /**
   * #1231. A correction edits the copy and keeps what it said before: each
   * user write of a copy first writes its previous values as a revision,
   * under the entry's lock, in the write's own transaction.
   */
  describe('revisions kept by each write', () => {
    /** The order the copy's revision and its write were made in. */
    function recordOrder(): string[] {
      const order: string[] = [];
      db.collectionCopyRevision.createMany.mockImplementation((async () => {
        order.push('revision');
        return { count: 1 };
      }) as never);
      db.collectionCopy.update.mockImplementation((async () => {
        order.push('write');
        return copyRow();
      }) as never);

      return order;
    }

    const BEFORE = copyRow({
      note: 'Unsleeved',
      condition: GameCondition.Good,
      pricePaidAmount: 1250,
      pricePaidCurrency: 'EUR',
      releaseId: 'rel-1',
    });

    it('editing a copy keeps what it said before as a revision (#1231)', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(BEFORE as never);
      const order = recordOrder();

      await service.update('gc-1', 'copy-1', { note: 'Sleeved' });

      expect(db.collectionCopy.findUnique).toHaveBeenCalledWith({
        where: { id: 'copy-1', entryId: 'gc-1', retractedAt: null },
        select: COPY_REVISION_SELECT,
      });
      expect(db.collectionCopyRevision.createMany).toHaveBeenCalledWith({
        data: [{ copyId: 'copy-1', values: copyRevisionValues(BEFORE) }],
      });
      expect(order).toEqual(['revision', 'write']);
    });

    it('removing a copy keeps what it said before as a revision (#1231)', async () => {
      db.collectionCopy.count.mockResolvedValue(2);
      db.collectionCopy.findUnique.mockResolvedValue(BEFORE as never);
      const order = recordOrder();

      await service.remove('gc-1', 'copy-1', { reason: GameRemovalReason.Sold });

      expect(db.collectionCopyRevision.createMany).toHaveBeenCalledWith({
        data: [{ copyId: 'copy-1', values: expect.objectContaining({ note: 'Unsleeved', removedAt: null }) }],
      });
      expect(order).toEqual(['revision', 'write']);
    });

    it('a refused edit keeps no revision', async () => {
      await expect(service.update('gc-1', 'copy-1', { removedOn: '2024' })).rejects.toMatchObject({
        code: 'COLLECTION_COPY_NOT_REMOVED',
      });
      expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
    });
  });

  describe('listRevisions', () => {
    const revisionRead = (revisions: unknown[]) =>
      db.gameCollection.findUnique.mockResolvedValue({ copies: [{ revisions }] } as never);

    // The history is the entry owner's alone, as the copy's details are, so
    // the entry is read as the acting user's own (#1231).
    it("lists the copy's revisions newest first, each in the owner's copy shape", async () => {
      const newer = new Date('2026-03-01T00:00:00Z');
      const older = new Date('2026-02-01T00:00:00Z');
      revisionRead([
        {
          id: 'rev-2',
          createdAt: newer,
          values: storedValues({
            releaseId: 'rel-1',
            acquiredOn: '2019-03-01',
            acquiredOnPrecision: DatePrecision.Month,
            pricePaidAmount: 1250,
            pricePaidCurrency: 'EUR',
            removedAt: '2024-07-01T10:00:00.000Z',
            removedOn: '2024-01-01',
            removedOnPrecision: DatePrecision.Year,
            removeReason: GameRemovalReason.Sold,
          }),
        },
        { id: 'rev-1', createdAt: older, values: storedValues({ releaseId: 'rel-gone', note: 'First' }) },
      ]);
      db.gameRelease.findMany.mockResolvedValue([{ id: 'rel-1', editionName: 'Deluxe', releaseYear: 2019 }] as never);

      const revisions = await service.listRevisions('gc-1', 'copy-1');

      expect(db.gameCollection.findUnique).toHaveBeenCalledWith({
        where: { id: 'gc-1', userId: ME, AND: [COND] },
        select: {
          copies: {
            where: { id: 'copy-1' },
            select: {
              revisions: {
                select: { id: true, createdAt: true, values: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              },
            },
          },
        },
      });
      expect(db.gameRelease.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['rel-1', 'rel-gone'] } },
        select: { id: true, editionName: true, releaseYear: true },
      });
      expect(revisions).toEqual([
        {
          id: 'rev-2',
          createdAt: newer,
          values: {
            acquiredFrom: null,
            acquiredOn: '2019-03',
            condition: null,
            currentValue: null,
            note: null,
            pricePaid: { amount: 1250, currency: 'EUR' },
            release: { id: 'rel-1', editionName: 'Deluxe', releaseYear: 2019 },
            removedAt: new Date('2024-07-01T10:00:00.000Z'),
            removedOn: '2024',
            removeReason: GameRemovalReason.Sold,
          },
        },
        // A release deleted since reads as none: restoring it writes none.
        { id: 'rev-1', createdAt: older, values: expect.objectContaining({ note: 'First', release: null }) },
      ]);
    });

    it('reads no release when no revision names one', async () => {
      revisionRead([{ id: 'rev-1', createdAt: new Date(), values: storedValues() }]);

      await service.listRevisions('gc-1', 'copy-1');

      expect(db.gameRelease.findMany).not.toHaveBeenCalled();
    });

    it('answers COLLECTION_COPY_NOT_FOUND for a copy the entry does not hold', async () => {
      db.gameCollection.findUnique.mockResolvedValue({ copies: [] } as never);

      await expect(service.listRevisions('gc-1', 'copy-9')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_COPY_NOT_FOUND',
      });
    });

    it("another user's revisions answer COLLECTION_ENTRY_NOT_FOUND (#1231)", async () => {
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.listRevisions('gc-1', 'copy-1')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
    });

    // A stored revision that can't be read back can't be restored either, so
    // the list leaves it out, and the server's log says why (#1231).
    it('leaves out a stored revision that fails the schema, and logs one line', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      revisionRead([
        { id: 'rev-2', createdAt: new Date(), values: { note: 7 } },
        { id: 'rev-1', createdAt: new Date(), values: storedValues() },
      ]);

      const revisions = await service.listRevisions('gc-1', 'copy-1');

      expect(revisions.map(({ id }) => id)).toEqual(['rev-1']);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toHaveLength(1);
      expect(logged.mock.calls[0]?.[0]).toEqual(expect.stringContaining('rev-2'));
      expect(logged.mock.calls[0]?.[0]).not.toContain('\n');
    });
  });

  describe('restore', () => {
    /** The entry's live copy, owned, as the restore reads it (#1231). */
    const CURRENT = copyRow({ note: 'Now', retractedAt: null });

    beforeEach(() => {
      db.collectionCopy.findUnique.mockResolvedValue(CURRENT as never);
    });

    it("writes the revision's values back, and stamps the copy as edited by the user (#1231)", async () => {
      db.collectionCopyRevision.findUnique.mockResolvedValue({
        values: storedValues({
          condition: GameCondition.Good,
          acquiredOn: '2019-03-01',
          acquiredOnPrecision: DatePrecision.Month,
          acquiredFrom: 'A friend',
          pricePaidAmount: 2500,
          pricePaidCurrency: 'USD',
          note: 'Then',
        }),
      } as never);
      db.collectionCopy.update.mockResolvedValue(copyRow({ note: 'Then' }) as never);

      const restored = await service.restore('gc-1', 'copy-1', 'rev-1');

      expectLockedThenChecked();
      // A taken-back copy never existed, so it takes no restore (#1231).
      expect(db.collectionCopy.findUnique).toHaveBeenCalledWith({
        where: { id: 'copy-1', entryId: 'gc-1', retractedAt: null },
        select: COPY_REVISION_SELECT,
      });
      expect(db.collectionCopyRevision.findUnique).toHaveBeenCalledWith({
        where: { id: 'rev-1', copyId: 'copy-1' },
        select: { values: true },
      });
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionCopy.update).toHaveBeenCalledWith({
        where: { id: 'copy-1' },
        data: {
          releaseId: null,
          condition: GameCondition.Good,
          acquiredOn: new Date('2019-03-01T00:00:00Z'),
          acquiredOnPrecision: DatePrecision.Month,
          acquiredFrom: 'A friend',
          pricePaidAmount: 2500,
          pricePaidCurrency: 'USD',
          currentValueAmount: null,
          currentValueCurrency: null,
          note: 'Then',
          removedAt: null,
          removedOn: null,
          removedOnPrecision: null,
          removeReason: null,
          editedByUserAt: now,
        },
        select: OWNER_COPY_SELECT,
      });
      expect(restored).toMatchObject({ id: 'copy-1', note: 'Then' });
    });

    it('restoring a revision records the current values as a revision first (#1231)', async () => {
      const order: string[] = [];
      db.collectionCopyRevision.createMany.mockImplementation((async () => {
        order.push('revision');
        return { count: 1 };
      }) as never);
      db.collectionCopy.update.mockImplementation((async () => {
        order.push('write');
        return copyRow();
      }) as never);

      await service.restore('gc-1', 'copy-1', 'rev-1');

      expect(db.collectionCopyRevision.createMany).toHaveBeenCalledWith({
        data: [{ copyId: 'copy-1', values: copyRevisionValues(CURRENT) }],
      });
      expect(order).toEqual(['revision', 'write']);
    });

    // Review Focus 5: a release deleted since the revision was kept must not
    // fail the restore on its foreign key; the copy is restored with none.
    // The release is read under a share lock, so it can't go before the
    // write either (#1231).
    it('a revision whose release has since gone restores with no release (#1231)', async () => {
      db.collectionCopyRevision.findUnique.mockResolvedValue({
        values: storedValues({ releaseId: 'rel-gone' }),
      } as never);
      db.$queryRaw.mockResolvedValueOnce([LOCKED] as never).mockResolvedValueOnce([] as never);

      await service.restore('gc-1', 'copy-1', 'rev-1');

      const [held] = db.$queryRaw.mock.calls[1] as unknown as [Prisma.Sql];
      expect(rawQueryText(held)).toMatch(/FROM game_releases WHERE id = \? AND platform_game_id = \? FOR SHARE$/);
      expect(held.values).toEqual(['rel-gone', 'pg-1']);
      expect(db.collectionCopy.update.mock.calls[0]?.[0]?.data).toMatchObject({ releaseId: null });
    });

    it('a revision whose release still exists restores it', async () => {
      db.collectionCopyRevision.findUnique.mockResolvedValue({ values: storedValues({ releaseId: 'rel-1' }) } as never);
      db.$queryRaw.mockResolvedValueOnce([LOCKED] as never).mockResolvedValueOnce([{ id: 'rel-1' }] as never);

      await service.restore('gc-1', 'copy-1', 'rev-1');

      expect(db.collectionCopy.update.mock.calls[0]?.[0]?.data).toMatchObject({ releaseId: 'rel-1' });
    });

    it('answers COLLECTION_REVISION_NOT_FOUND for a revision of another copy, or none, and writes nothing', async () => {
      db.collectionCopyRevision.findUnique.mockResolvedValue(null);

      await expect(service.restore('gc-1', 'copy-1', 'rev-9')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_REVISION_NOT_FOUND',
      });
      expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    it('answers COLLECTION_COPY_NOT_FOUND for a copy the entry does not hold', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(null);

      await expect(service.restore('gc-1', 'copy-9', 'rev-1')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_COPY_NOT_FOUND',
      });
      expect(db.collectionCopyRevision.findUnique).not.toHaveBeenCalled();
    });

    // The stored values are data from outside the process, read back with
    // their schema. One that fails it can't be restored: the client is told
    // the revision isn't there, and the server's log says why, on one line,
    // as nestjs-pino drops an Error argument (#1231).
    it('a stored revision that fails the schema answers COLLECTION_REVISION_NOT_FOUND and logs one line (#1231)', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      db.collectionCopyRevision.findUnique.mockResolvedValue({
        values: { ...storedValues(), pricePaidAmount: 100 },
      } as never);

      await expect(service.restore('gc-1', 'copy-1', 'rev-1')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_REVISION_NOT_FOUND',
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toHaveLength(1);
      expect(logged.mock.calls[0]?.[0]).toEqual(expect.stringContaining('rev-1'));
      expect(logged.mock.calls[0]?.[0]).not.toContain('\n');
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    // A restore is held to what any copy write is: the values it writes are
    // checked as an edit's would be (#1231).
    it('refuses a restored removal that ends before the acquisition with COLLECTION_DATE_ORDER', async () => {
      db.collectionCopyRevision.findUnique.mockResolvedValue({
        values: storedValues({
          acquiredOn: '2020-05-01',
          acquiredOnPrecision: DatePrecision.Month,
          removedAt: '2020-06-01T00:00:00.000Z',
          removedOn: '2020-03-01',
          removedOnPrecision: DatePrecision.Month,
        }),
      } as never);

      await expect(service.restore('gc-1', 'copy-1', 'rev-1')).rejects.toMatchObject({ code: 'COLLECTION_DATE_ORDER' });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    it("refuses a restored condition on a digital entry's copy with COLLECTION_CONDITION_DIGITAL", async () => {
      db.$queryRaw.mockResolvedValue([{ ...LOCKED, medium: GameMedium.Digital }] as never);
      db.collectionCopyRevision.findUnique.mockResolvedValue({
        values: storedValues({ condition: GameCondition.Good }),
      } as never);

      await expect(service.restore('gc-1', 'copy-1', 'rev-1')).rejects.toMatchObject({
        code: 'COLLECTION_CONDITION_DIGITAL',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    describe('a revision of the copy removed', () => {
      const REMOVED_VALUES = storedValues({
        removedAt: '2024-07-01T10:00:00.000Z',
        removedOn: '2024-06-01',
        removedOnPrecision: DatePrecision.Month,
        removeReason: GameRemovalReason.Traded,
      });

      beforeEach(() => {
        db.collectionCopyRevision.findUnique.mockResolvedValue({ values: REMOVED_VALUES } as never);
      });

      // The removal's date and reason are the revision's; the copy becomes
      // removed by this restore, so the removal is recorded as written now
      // (#1231).
      it("writes the revision's removal date and reason back, recorded now", async () => {
        db.collectionCopy.count.mockResolvedValue(2);

        await service.restore('gc-1', 'copy-1', 'rev-1');

        const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
        expect(db.collectionCopy.update.mock.calls[0]?.[0]?.data).toMatchObject({
          removedAt: now,
          removedOn: new Date('2024-06-01T00:00:00Z'),
          removedOnPrecision: DatePrecision.Month,
          removeReason: GameRemovalReason.Traded,
        });
        // Another copy is still owned, so the entry stays, and needs no delete permission.
        expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      });

      // Restoring a removal of the entry's last owned copy removes the entry,
      // so it is held to the entry's delete permission, as the copy removal
      // is (#1288); the entry takes the restored reason (#1231).
      it("on the last owned copy needs the entry's delete permission, and removes the entry with the restored reason", async () => {
        db.gameCollection.findUniqueOrThrow.mockResolvedValue({ deletedAt: null, _count: { copies: 0 } } as never);
        db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Lost } as never);

        await service.restore('gc-1', 'copy-1', 'rev-1');

        expect(db.collectionCopy.count).toHaveBeenCalledWith({
          where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
        });
        expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.delete, ResourceType.GameCollection, {
          id: 'gc-1',
          ...LOCKED,
        });
        expect(db.collectionCopy.findFirst).not.toHaveBeenCalled();
        expect(db.gameCollection.update).toHaveBeenLastCalledWith({
          where: { id: 'gc-1' },
          data: { deletedAt: expect.any(Date), deleteReason: GameRemovalReason.Traded, lastUpdated: expect.any(Date) },
          select: { id: true },
        });
        expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: expect.any(Date) }, expect.any(Date));
      });

      it('refuses the last owned copy to an actor that may not remove the entry, and writes nothing', async () => {
        abilityService.assertCurrentActorCan.mockImplementation(() => {
          throw new ForbiddenException();
        });

        await expect(service.restore('gc-1', 'copy-1', 'rev-1')).rejects.toThrow(ForbiddenException);
        expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
        expect(db.collectionCopy.update).not.toHaveBeenCalled();
      });

      // A copy that stays removed keeps when its removal was recorded, so the
      // copy that removed the entry is still the one removed at the entry's
      // `deletedAt` (#1231).
      it("of a copy already removed keeps its removal stamp, with the revision's date and reason", async () => {
        const stamp = new Date('2025-09-01T12:00:00Z');
        db.collectionCopy.findUnique.mockResolvedValue(copyRow({ removedAt: stamp, retractedAt: null }) as never);

        await service.restore('gc-1', 'copy-1', 'rev-1');

        expect(db.collectionCopy.update.mock.calls[0]?.[0]?.data).toMatchObject({
          removedAt: stamp,
          removedOn: new Date('2024-06-01T00:00:00Z'),
          removedOnPrecision: DatePrecision.Month,
          removeReason: GameRemovalReason.Traded,
        });
      });

      // The write runner reads a removed entry's reason again, on every write
      // of its copies, from the copy removed at the entry's `deletedAt`. A
      // restore that removes the entry records its copy's removal at that
      // instant, so a later edit of another removed copy keeps the restored
      // reason, rather than the reason of the copy removed last (#1231).
      it("a later copy edit keeps the entry's restored reason (#1231)", async () => {
        const removedCopies: { removedAt: Date; removeReason: GameRemovalReason }[] = [
          { removedAt: new Date('2025-06-01T00:00:00Z'), removeReason: GameRemovalReason.Sold },
        ];
        db.collectionCopy.findFirst.mockImplementation((async (args: { where: { removedAt?: Date } }) => {
          const at = args.where.removedAt;
          const [latest] = removedCopies
            .filter(({ removedAt }) => at === undefined || removedAt.getTime() === at.getTime())
            .sort((a, b) => b.removedAt.getTime() - a.removedAt.getTime());

          return latest === undefined ? null : { removeReason: latest.removeReason };
        }) as never);
        db.gameCollection.findUniqueOrThrow.mockResolvedValue({ deletedAt: null, _count: { copies: 0 } } as never);

        await service.restore('gc-1', 'copy-1', 'rev-1');

        const restoredCopy = db.collectionCopy.update.mock.calls[0]?.[0]?.data;
        const removedEntry = db.gameCollection.update.mock.calls.at(-1)?.[0]?.data;
        expect(removedEntry).toMatchObject({ deleteReason: GameRemovalReason.Traded });
        expect(restoredCopy?.removedAt).toEqual(removedEntry?.deletedAt);

        // The copy as the restore left it, and a note edit of the other copy.
        removedCopies.push({ removedAt: restoredCopy?.removedAt as Date, removeReason: GameRemovalReason.Traded });
        db.gameCollection.findUniqueOrThrow.mockResolvedValue({
          deletedAt: removedEntry?.deletedAt,
          _count: { copies: 0 },
        } as never);
        db.collectionCopy.findUnique.mockResolvedValue(
          copyRow({ id: 'copy-2', removedAt: new Date('2025-06-01T00:00:00Z'), retractedAt: null }) as never,
        );

        await service.update('gc-1', 'copy-2', { note: 'Sold to a friend' });

        expect(db.gameCollection.update).toHaveBeenLastCalledWith({
          where: { id: 'gc-1' },
          data: { deleteReason: GameRemovalReason.Traded, lastUpdated: expect.any(Date) },
          select: { id: true },
        });
      });

      // A copy removed already removes nothing more by being removed again.
      it('of a copy already removed needs no delete permission', async () => {
        db.collectionCopy.findUnique.mockResolvedValue(
          copyRow({ removedAt: new Date('2025-01-01T00:00:00Z'), retractedAt: null }) as never,
        );

        await service.restore('gc-1', 'copy-1', 'rev-1');

        expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      });
    });

    // Restoring what the copy said before its removal makes it owned again,
    // and the entry comes back with it; the write runner then resumes the
    // offers its removal paused (#1221).
    it('restoring an owned revision of a removed copy brings the entry back and syncs its offers (#1221)', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(
        copyRow({ removedAt: new Date('2025-01-01T00:00:00Z'), retractedAt: null }) as never,
      );
      db.gameCollection.findUniqueOrThrow.mockResolvedValue({
        deletedAt: new Date('2025-01-01T00:00:00Z'),
        _count: { copies: 1 },
      } as never);

      await service.restore('gc-1', 'copy-1', 'rev-1');

      expect(db.gameCollection.update).toHaveBeenLastCalledWith({
        where: { id: 'gc-1' },
        data: { deletedAt: null, deleteReason: null, lastUpdated: expect.any(Date) },
        select: { id: true },
      });
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: null }, expect.any(Date));
    });
  });

  /**
   * #1231. Taking a copy back says it never existed: it counts as neither
   * owned nor removed. It is the user's word on the copy, so it stamps the
   * copy as edited by the user, and a sync never brings the copy back. It
   * changes none of the values a revision holds, so it keeps none.
   */
  describe('takeBack', () => {
    it('stamps the copy taken back and edited by the user, and keeps no revision', async () => {
      db.collectionCopy.update.mockResolvedValue(copyRow({ retractedAt: new Date('2026-11-26T00:00:00Z') }) as never);

      const taken = await service.takeBack('gc-1', 'copy-1');

      expectLockedThenChecked();
      expect(db.collectionCopy.findUnique).toHaveBeenCalledWith({
        where: { id: 'copy-1', entryId: 'gc-1', retractedAt: null },
        select: { removedAt: true },
      });
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionCopy.update).toHaveBeenCalledWith({
        where: { id: 'copy-1' },
        data: { retractedAt: now, editedByUserAt: now },
        select: OWNER_COPY_SELECT,
      });
      // A revision would hold the values the copy still has (#1231).
      expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
      expect(taken).toMatchObject({ id: 'copy-1', retractedAt: new Date('2026-11-26T00:00:00Z') });
    });

    // The entry keeps another owned copy, counted under the entry's lock,
    // so it stays, and the take-back needs no delete permission.
    it('takes back an owned copy while the entry owns another', async () => {
      await service.takeBack('gc-1', 'copy-1');

      expect(db.collectionCopy.count).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', id: { not: 'copy-1' }, removedAt: null, retractedAt: null },
      });
      expect(db.collectionCopy.update).toHaveBeenCalled();
      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
    });

    // A copy that never existed can't remove the entry: the user adds the
    // right copy first, or removes the game (#1231).
    it('taking back the last owned copy is refused with COLLECTION_LAST_COPY, and writes nothing', async () => {
      db.collectionCopy.count.mockResolvedValue(0);

      await expect(service.takeBack('gc-1', 'copy-1')).rejects.toMatchObject({
        status: 409,
        code: 'COLLECTION_LAST_COPY',
      });
      expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    // A removed copy isn't owned, so taking it back changes no ownership.
    it('takes back a removed copy whatever the entry still owns', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(copyRow({ removedAt: new Date('2025-01-01T00:00:00Z') }) as never);
      db.collectionCopy.count.mockResolvedValue(0);

      await service.takeBack('gc-1', 'copy-1');

      expect(db.collectionCopy.count).not.toHaveBeenCalled();
      expect(db.collectionCopy.update).toHaveBeenCalled();
    });

    // A taken-back copy is no removal, so a removed entry whose only removed
    // copy is taken back stays removed with no reason left to read (#1231).
    it("taking back a removed entry's only removed copy leaves it removed, with no reason", async () => {
      db.collectionCopy.findUnique.mockResolvedValue(copyRow({ removedAt: new Date('2025-01-01T00:00:00Z') }) as never);
      db.gameCollection.findUniqueOrThrow.mockResolvedValue({
        deletedAt: new Date('2025-01-01T00:00:00Z'),
        _count: { copies: 0 },
      } as never);
      db.collectionCopy.findFirst.mockResolvedValue(null);

      await service.takeBack('gc-1', 'copy-1');

      expect(db.gameCollection.update).toHaveBeenLastCalledWith({
        where: { id: 'gc-1' },
        data: { deleteReason: null, lastUpdated: expect.any(Date) },
        select: { id: true },
      });
      expect(syncSupply).not.toHaveBeenCalled();
    });

    it('taking back an already taken-back copy answers COLLECTION_COPY_NOT_FOUND', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(null);

      await expect(service.takeBack('gc-1', 'copy-1')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_COPY_NOT_FOUND',
      });
      expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });
  });

  /** #1231. Undoing a take-back makes the copy count again, as it was before. */
  describe('undoTakeBack', () => {
    beforeEach(() => {
      db.collectionCopy.findUnique.mockResolvedValue(
        copyRow({ retractedAt: new Date('2026-11-01T00:00:00Z') }) as never,
      );
    });

    it('undoing a take-back counts the copy again, stamped edited by the user, and keeps no revision', async () => {
      const taken = await service.undoTakeBack('gc-1', 'copy-1');

      expectLockedThenChecked();
      expect(db.collectionCopy.findUnique).toHaveBeenCalledWith({
        where: { id: 'copy-1', entryId: 'gc-1' },
        select: { retractedAt: true },
      });
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
      expect(db.collectionCopy.update).toHaveBeenCalledWith({
        where: { id: 'copy-1' },
        data: { retractedAt: null, editedByUserAt: now },
        select: OWNER_COPY_SELECT,
      });
      expect(taken).toMatchObject({ id: 'copy-1' });
    });

    // The copy owned again acquires the entry again, and the write runner
    // resumes the offers its removal paused (#1221).
    it('undoing a take-back of an owned copy on a removed entry brings the entry back and resumes its offers', async () => {
      db.gameCollection.findUniqueOrThrow.mockResolvedValue({
        deletedAt: new Date('2025-01-01T00:00:00Z'),
        _count: { copies: 1 },
      } as never);

      await service.undoTakeBack('gc-1', 'copy-1');

      expect(db.gameCollection.update).toHaveBeenLastCalledWith({
        where: { id: 'gc-1' },
        data: { deletedAt: null, deleteReason: null, lastUpdated: expect.any(Date) },
        select: { id: true },
      });
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: null }, expect.any(Date));
    });

    it('undoing a take-back of a removed copy changes no ownership', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(
        copyRow({
          removedAt: new Date('2025-01-01T00:00:00Z'),
          retractedAt: new Date('2026-11-01T00:00:00Z'),
        }) as never,
      );
      db.gameCollection.findUniqueOrThrow.mockResolvedValue({
        deletedAt: new Date('2025-01-01T00:00:00Z'),
        _count: { copies: 0 },
      } as never);

      await service.undoTakeBack('gc-1', 'copy-1');

      expect(syncSupply).not.toHaveBeenCalled();
      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
    });

    it('answers COLLECTION_COPY_NOT_FOUND for a copy the entry does not hold, and writes nothing', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(null);

      await expect(service.undoTakeBack('gc-1', 'copy-1')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_COPY_NOT_FOUND',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    // The copy is still there, so the refusal is never the copy's 404, which
    // a client reads as "this copy is gone" (#634, #1231).
    it('answers COLLECTION_COPY_NOT_TAKEN_BACK for a copy the entry holds that is not taken back, and writes nothing', async () => {
      db.collectionCopy.findUnique.mockResolvedValue(copyRow({ retractedAt: null }) as never);

      await expect(service.undoTakeBack('gc-1', 'copy-1')).rejects.toMatchObject({
        status: 409,
        code: 'COLLECTION_COPY_NOT_TAKEN_BACK',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });
  });

  /**
   * #1231. Each write answers the copy in the entry owner's shape, so the writes are
   * the entry owner's alone, as the list is. A role holding every permission (the
   * server's Owner) or a plugin with an update grant passes the update
   * conditions, so the entry's owner is checked beside them, under the lock,
   * before anything is written.
   */
  describe("another user's entry", () => {
    const writes = {
      // Keyed, so the refusal is shown to come before the key's lookup too.
      add: () => service.add('gc-1', { condition: GameCondition.Good, clientRequestId: 'key-1' }),
      update: () => service.update('gc-1', 'copy-1', { condition: GameCondition.Good }),
      remove: () => service.remove('gc-1', 'copy-1', {}),
      restore: () => service.restore('gc-1', 'copy-1', 'rev-1'),
      takeBack: () => service.takeBack('gc-1', 'copy-1'),
      undoTakeBack: () => service.undoTakeBack('gc-1', 'copy-1'),
    } as const;
    const methods = Object.keys(writes) as (keyof typeof writes)[];

    // The lock names the acting user, so another user's entry is never
    // locked: a request for it can't make its owner's writes wait (#1231).
    it.each(methods)(
      '%s answers COLLECTION_ENTRY_NOT_FOUND to a reader whose grants pass the update conditions, and locks and writes nothing',
      async (method) => {
        // The lock finds no row of the acting user's under another user's entry id.
        db.$queryRaw.mockResolvedValue([] as never);

        await expect(writes[method]()).rejects.toMatchObject({ status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
        const [lock] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
        expect(rawQueryText(lock)).toMatch(/WHERE id = \? AND user_id = \? FOR UPDATE$/);
        expect(lock.values).toEqual(['gc-1', ME]);
        expect(db.gameCollection.update).not.toHaveBeenCalled();
        // Nothing of the entry's copies is read before the refusal either.
        expect(db.collectionCopy.findUnique).not.toHaveBeenCalled();
        expect(db.collectionCopy.count).not.toHaveBeenCalled();
        expect(db.collectionCopy.create).not.toHaveBeenCalled();
        expect(db.collectionCopy.update).not.toHaveBeenCalled();
        expect(db.collectionCopyRevision.findUnique).not.toHaveBeenCalled();
        expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
        expect(syncSupply).not.toHaveBeenCalled();
      },
    );

    // A plugin, the system or an external actor has no collection of its own.
    it.each(methods)('%s answers COLLECTION_ENTRY_NOT_FOUND to an actor that is no user', async (method) => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(writes[method]()).rejects.toMatchObject({ status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.gameCollection.update).not.toHaveBeenCalled();
      expect(db.collectionCopy.findUnique).not.toHaveBeenCalled();
      expect(db.collectionCopy.count).not.toHaveBeenCalled();
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    // An API key acts for the user who made it: here the entry's owner, so it
    // writes that user's copies.
    it.each(methods)("%s lets an API key acting for the entry's owner write", async (method) => {
      abilityService.getActingUserId.mockReturnValue('key-owner');
      db.$queryRaw.mockResolvedValue([{ ...LOCKED, userId: 'key-owner' }] as never);

      await expect(writes[method]()).resolves.toMatchObject({ id: 'copy-1' });
    });
  });
});
