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
import { syncCollectionEntrySupply } from '@bge/event';
import { AbilityService } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, rawQueryText, unwrapTransaction } from '@bge/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CollectionCopyService } from './collection-copy.service';
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
    service = ctx.module.get(CollectionCopyService);
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * Each write's first statement locks the entry's row, so it takes turns
   * with nominations naming the entry (#1221); then the entry is held to the
   * actor's update conditions (#1288).
   */
  function expectLockedThenChecked(): void {
    const [lock] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
    expect(rawQueryText(lock)).toMatch(/FROM game_collections WHERE id = \? FOR UPDATE$/);
    expect(lock.values).toEqual(['gc-1']);
    expect(db.gameCollection.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'gc-1', AND: [COND] },
      data: { lastUpdated: expect.any(Date) },
      select: { id: true },
    });
    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.GameCollection,
      Action.update,
    );
  }

  describe('list', () => {
    // A copy's acquisition and price are the owner's alone, whatever the
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
      expect(db.collectionCopy.count).toHaveBeenCalledWith({ where: { entryId: 'gc-1' } });
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
      expect(db.collectionCopy.findUnique).toHaveBeenCalledWith({
        where: { id: 'copy-1', entryId: 'gc-1' },
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
    ])('refuses %s on a copy still owned with COLLECTION_COPY_OWNED', async (_, dto) => {
      await expect(service.update('gc-1', 'copy-1', dto)).rejects.toMatchObject({
        status: 409,
        code: 'COLLECTION_COPY_OWNED',
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
      // reason of the copy whose removal removed it corrects the entry's too.
      it("a corrected removal reason updates the entry's reason (#1231)", async () => {
        db.gameCollection.findUniqueOrThrow.mockResolvedValue({
          deletedAt: new Date('2024-07-01T00:00:00Z'),
          _count: { copies: 0 },
        } as never);
        db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Stolen } as never);

        await service.update('gc-1', 'copy-1', { removeReason: GameRemovalReason.Stolen });

        expect(db.gameCollection.update).toHaveBeenLastCalledWith({
          where: { id: 'gc-1' },
          data: { deleteReason: GameRemovalReason.Stolen, lastUpdated: expect.any(Date) },
          select: { id: true },
        });
        expect(syncSupply).not.toHaveBeenCalled();
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
        select: { acquiredOn: true, acquiredOnPrecision: true },
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

    it('refuses a removal dated before the copy was acquired with COLLECTION_DATE_ORDER', async () => {
      db.collectionCopy.findUnique.mockResolvedValue({
        acquiredOn: new Date('2020-05-01T00:00:00Z'),
        acquiredOnPrecision: DatePrecision.Month,
      } as never);

      await expect(service.remove('gc-1', 'copy-1', { removedOn: '2020-03' })).rejects.toMatchObject({
        code: 'COLLECTION_DATE_ORDER',
      });
      expect(db.collectionCopy.update).not.toHaveBeenCalled();
    });

    it('refuses a removal dated after today with COLLECTION_DATE_IN_FUTURE, before any write', async () => {
      await expect(service.remove('gc-1', 'copy-1', { removedOn: '9999' })).rejects.toMatchObject({
        code: 'COLLECTION_DATE_IN_FUTURE',
      });
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });
});
