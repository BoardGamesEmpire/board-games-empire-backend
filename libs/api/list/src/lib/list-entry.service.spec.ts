import { Action, ListKind, Prisma, ResourceType, WishlistPriority } from '@bge/database';
import { uniqueViolation, uniqueViolationWithoutMeta } from '@bge/database/testing';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  rawQueryText,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { Logger } from '@nestjs/common';
import { LIST_ENTRY_SELECT } from './list-entry-row';
import { ListEntryService } from './list-entry.service';
import { LIST_MAX_ENTRIES } from './list.constants';

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Dependent record not found', { code: 'P2025', clientVersion: 'test' });

const foreignKeyViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' });

/**
 * Each ceiling names its action and resource type, so a where clause shows
 * which one it was built from: the list's update ceiling for the lock, the
 * game's read ceiling for a game's readability.
 */
const ceiling = (action: Action, type: ResourceType) => ({ ceiling: `${action}:${type}` });

const LIST = 'list-1';
const ENTRY_ORDER = [{ position: 'asc' }, { id: 'asc' }];

const entryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'entry-1',
  listId: LIST,
  gameId: 'game-1',
  platformGameId: null,
  releaseId: null,
  position: 0,
  priority: null,
  note: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  game: { id: 'game-1', title: 'Catan' },
  platformGame: null,
  release: null,
  ...overrides,
});

const LIST_NOT_FOUND = { status: 404, code: 'LIST_NOT_FOUND' };
const ENTRY_NOT_FOUND = { status: 404, code: 'LIST_ENTRY_NOT_FOUND' };
const ORDER_STALE = { status: 409, code: 'LIST_ORDER_STALE' };
const NOTHING_TO_UPDATE = {
  status: 400,
  code: 'NOTHING_TO_UPDATE',
  response: { message: t('common.at_least_one_field') },
};

/** What an entry named was missing, or not the actor's to read: a coded 404 naming it (#1241). */
const gameNotFound = (id: string) => ({
  status: 404,
  code: 'GAME_NOT_FOUND',
  response: { message: t('errors.game.not_found', { id }) },
});
const platformGameNotFound = (id: string) => ({
  status: 404,
  code: 'PLATFORM_GAME_NOT_FOUND',
  response: { message: t('errors.platform_game.not_found', { id }) },
});
const gameReleaseNotFound = (id: string) => ({
  status: 404,
  code: 'GAME_RELEASE_NOT_FOUND',
  response: { message: t('errors.game_release.not_found', { id }) },
});

describe('ListEntryService', () => {
  let service: ListEntryService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions'>>;
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn((type: ResourceType, action: Action) => [ceiling(action, type)]) as never,
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        ListEntryService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the routes actually run.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    unwrapTransaction(db);
    service = ctx.module.get(ListEntryService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');

    // By default: a custom list the actor may write, a game they may read,
    // and no entries yet.
    db.list.update.mockResolvedValue({ kind: ListKind.Custom } as never);
    db.game.findFirst.mockResolvedValue({ id: 'game-1' } as never);
    db.listEntry.aggregate.mockResolvedValue({ _count: { _all: 0 }, _max: { position: null } } as never);
    db.listEntry.create.mockResolvedValue(entryRow() as never);
    db.listEntry.update.mockResolvedValue(entryRow() as never);
  });

  afterEach(() => jest.clearAllMocks());

  describe('list', () => {
    it("reads a list's entries with the list read under its ceiling, and 404s a list the actor cannot see (#1241)", async () => {
      db.list.findFirst.mockResolvedValue({ id: LIST } as never);
      db.listEntry.findMany.mockResolvedValue([entryRow()] as never);
      db.listEntry.count.mockResolvedValue(1);

      const page = await service.list(LIST, paginationQuery({ limit: 20 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.List, Action.read, { id: LIST });
      expect(db.list.findFirst).toHaveBeenCalledWith({
        where: { id: LIST, AND: [ceiling(Action.read, ResourceType.List)] },
        select: { id: true },
      });
      // A top-level read of the entries, not a relation filter under the list:
      // Prisma drops a deny-all ceiling inside one (docs/agents/gotchas.md).
      expect(db.listEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { listId: LIST }, select: LIST_ENTRY_SELECT, orderBy: ENTRY_ORDER }),
      );
      expect(db.listEntry.count).toHaveBeenCalledWith({ where: { listId: LIST } });
      expect(page).toEqual({ rows: [entryRow()], total: 1 });

      db.list.findFirst.mockResolvedValue(null);

      await expect(service.list('list-9', paginationQuery({ limit: 20 }))).rejects.toMatchObject(LIST_NOT_FOUND);
    });

    // A list made Private or deleted between a separate check and the entry
    // read would otherwise be answered with entries the reader may no longer
    // see, or with an empty 200 for a list that is gone.
    it('reads the list, its rows and their count in one REPEATABLE READ snapshot (#1241)', async () => {
      db.list.findFirst.mockResolvedValue({ id: LIST } as never);
      db.listEntry.findMany.mockResolvedValue([]);
      db.listEntry.count.mockResolvedValue(0);

      await service.list(LIST, paginationQuery({ limit: 20 }));

      const { operations, options } = batchTransactionCall(db);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(operations).toHaveLength(3);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });
  });

  describe('add', () => {
    it('refuses an entry naming both or neither of a game and a platform game with LIST_ENTRY_ONE_TARGET (#1241)', async () => {
      const oneTarget = { status: 400, code: 'LIST_ENTRY_ONE_TARGET' };

      await expect(service.add(LIST, { gameId: 'game-1', platformGameId: 'pg-1' })).rejects.toMatchObject(oneTarget);
      await expect(service.add(LIST, {})).rejects.toMatchObject(oneTarget);
      // A JSON null names nothing, as an omitted id does.
      await expect(service.add(LIST, { gameId: null, platformGameId: null } as never)).rejects.toMatchObject(oneTarget);

      expect(db.listEntry.create).not.toHaveBeenCalled();
    });

    it('refuses a game the actor cannot read as not found, through the game read ceiling (#1241)', async () => {
      db.game.findFirst.mockResolvedValue(null);

      await expect(service.add(LIST, { gameId: 'game-1' })).rejects.toMatchObject(gameNotFound('game-1'));
      expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, { id: 'game-1', deletedAt: null });
      expect(db.game.findFirst).toHaveBeenCalledWith({
        where: { id: 'game-1', deletedAt: null, AND: [ceiling(Action.read, ResourceType.Game)] },
        select: { id: true },
      });

      // A platform game is readable through its game, and a miss answers as
      // the platform game the entry named.
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1', gameId: 'game-2' } as never);

      await expect(service.add(LIST, { platformGameId: 'pg-1' })).rejects.toMatchObject(platformGameNotFound('pg-1'));
      expect(db.platformGame.findUnique).toHaveBeenCalledWith({
        where: { id: 'pg-1' },
        select: { id: true, gameId: true },
      });
      expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, { id: 'game-2', deletedAt: null });

      // A platform game that doesn't exist answers the same.
      db.platformGame.findUnique.mockResolvedValue(null);

      await expect(service.add(LIST, { platformGameId: 'pg-9' })).rejects.toMatchObject(platformGameNotFound('pg-9'));

      expect(db.listEntry.create).not.toHaveBeenCalled();
    });

    it('refuses a priority on an entry of any list but the wishlist with LIST_PRIORITY_WISHLIST_ONLY (#1241)', async () => {
      const wishlistOnly = { status: 400, code: 'LIST_PRIORITY_WISHLIST_ONLY' };

      await expect(service.add(LIST, { gameId: 'game-1', priority: WishlistPriority.MustHave })).rejects.toMatchObject(
        wishlistOnly,
      );
      await expect(service.update(LIST, 'entry-1', { priority: WishlistPriority.LoveToHave })).rejects.toMatchObject(
        wishlistOnly,
      );

      expect(db.listEntry.create).not.toHaveBeenCalled();
      expect(db.listEntry.update).not.toHaveBeenCalled();

      // Clearing a priority is no priority, so any list takes it.
      await service.update(LIST, 'entry-1', { priority: null });
      expect(db.listEntry.update).toHaveBeenCalledWith(expect.objectContaining({ data: { priority: null } }));

      // The wishlist takes one, on add and on update.
      db.list.update.mockResolvedValue({ kind: ListKind.Wishlist } as never);

      await service.add(LIST, { gameId: 'game-1', priority: WishlistPriority.MustHave });
      await service.update(LIST, 'entry-1', { priority: WishlistPriority.DontBuy });

      expect(db.listEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ priority: WishlistPriority.MustHave }) }),
      );
      expect(db.listEntry.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { priority: WishlistPriority.DontBuy } }),
      );
    });

    it('refuses a release without a platform game, and one from another platform game (#1241)', async () => {
      const needsPlatformGame = { status: 400, code: 'LIST_ENTRY_RELEASE_NEEDS_PLATFORM_GAME' };
      const mismatch = { status: 400, code: 'LIST_ENTRY_RELEASE_MISMATCH' };

      // On add: a release beside a game on any platform, then one of another
      // platform game.
      await expect(service.add(LIST, { gameId: 'game-1', releaseId: 'rel-1' })).rejects.toMatchObject(
        needsPlatformGame,
      );

      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1', gameId: 'game-1' } as never);
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-2' } as never);

      await expect(service.add(LIST, { platformGameId: 'pg-1', releaseId: 'rel-1' })).rejects.toMatchObject(mismatch);
      expect(db.gameRelease.findUnique).toHaveBeenCalledWith({
        where: { id: 'rel-1' },
        select: { platformGameId: true },
      });
      expect(db.listEntry.create).not.toHaveBeenCalled();

      // On update: the entry's own target decides, read within the list.
      db.listEntry.findUnique.mockResolvedValueOnce({ platformGameId: null } as never);

      await expect(service.update(LIST, 'entry-1', { releaseId: 'rel-1' })).rejects.toMatchObject(needsPlatformGame);
      expect(db.listEntry.findUnique).toHaveBeenCalledWith({
        where: { id: 'entry-1', listId: LIST },
        select: { platformGameId: true },
      });

      db.listEntry.findUnique.mockResolvedValueOnce({ platformGameId: 'pg-1' } as never);

      await expect(service.update(LIST, 'entry-1', { releaseId: 'rel-1' })).rejects.toMatchObject(mismatch);
      expect(db.listEntry.update).not.toHaveBeenCalled();
    });

    it('answers LIST_ENTRY_EXISTS when the game is already on the list (#1241)', async () => {
      const exists = { status: 409, code: 'LIST_ENTRY_EXISTS' };
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1', gameId: 'game-1' } as never);

      // Each unique in every spelling a P2002 reports it, and one whose
      // constraint can't be named: the only other unique on the table is its
      // generated primary key.
      const duplicates = [
        uniqueViolation({ index: 'list_entries_list_id_game_id_key' }),
        uniqueViolation({ index: 'list_entries_list_id_platform_game_id_key' }),
        uniqueViolation({ fields: ['list_id', 'game_id'] }),
        uniqueViolation({ fields: ['list_id', 'platform_game_id'] }),
        uniqueViolation({ target: ['listId', 'gameId'] }),
        uniqueViolation({ target: ['listId', 'platformGameId'] }),
        uniqueViolationWithoutMeta(),
      ];

      for (const duplicate of duplicates) {
        db.listEntry.create.mockRejectedValueOnce(duplicate);
        await expect(service.add(LIST, { gameId: 'game-1' })).rejects.toMatchObject(exists);

        db.listEntry.create.mockRejectedValueOnce(duplicate);
        await expect(service.add(LIST, { platformGameId: 'pg-1' })).rejects.toMatchObject(exists);
      }
    });

    it('passes a unique violation on any other constraint through (#1241)', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const other = uniqueViolation({ index: 'list_entries_pkey' });
      db.listEntry.create.mockRejectedValue(other);

      await expect(service.add(LIST, { gameId: 'game-1' })).rejects.toBe(other);
    });

    it('refuses the entry past LIST_MAX_ENTRIES with LIST_FULL (#1241)', async () => {
      db.listEntry.aggregate.mockResolvedValue({
        _count: { _all: LIST_MAX_ENTRIES },
        _max: { position: LIST_MAX_ENTRIES - 1 },
      } as never);

      await expect(service.add(LIST, { gameId: 'game-1' })).rejects.toMatchObject({
        status: 409,
        code: 'LIST_FULL',
        response: { limit: LIST_MAX_ENTRIES },
      });
      expect(db.listEntry.aggregate).toHaveBeenCalledWith({
        where: { listId: LIST },
        _count: { _all: true },
        _max: { position: true },
      });
      expect(db.listEntry.create).not.toHaveBeenCalled();

      // One short of the cap still fits.
      db.listEntry.aggregate.mockResolvedValue({
        _count: { _all: LIST_MAX_ENTRIES - 1 },
        _max: { position: LIST_MAX_ENTRIES - 2 },
      } as never);

      await expect(service.add(LIST, { gameId: 'game-1' })).resolves.toEqual(entryRow());
    });

    it('locks the list row before reading positions, so concurrent adds and reorders serialize (#1241)', async () => {
      const order: string[] = [];
      db.$transaction.mockImplementation((async (cb: (tx: MockDatabaseService) => Promise<unknown>) => {
        order.push('begin');
        const result = await cb(db);
        order.push('commit');
        return result;
      }) as never);
      db.list.update.mockImplementation((async () => {
        order.push('lock list');
        return { kind: ListKind.Custom };
      }) as never);
      db.game.findFirst.mockImplementation((async () => {
        order.push('read game');
        return { id: 'game-1' };
      }) as never);
      db.listEntry.aggregate.mockImplementation((async () => {
        order.push('read positions');
        return { _count: { _all: 0 }, _max: { position: null } };
      }) as never);
      db.listEntry.create.mockImplementation((async () => {
        order.push('insert');
        return entryRow();
      }) as never);

      await service.add(LIST, { gameId: 'game-1' });

      expect(order).toEqual(['begin', 'lock list', 'read game', 'read positions', 'insert', 'commit']);
      expect(db.list.update).toHaveBeenCalledWith({
        where: { id: LIST, AND: [ceiling(Action.update, ResourceType.List)] },
        data: { updatedAt: expect.any(Date) },
        select: { kind: true },
      });

      order.length = 0;
      db.listEntry.findMany
        .mockImplementationOnce((async () => {
          order.push('read entries');
          return [{ id: 'entry-1' }];
        }) as never)
        .mockImplementationOnce((async () => {
          order.push('read back');
          return [entryRow()];
        }) as never);
      db.$executeRaw.mockImplementation((async () => {
        order.push('renumber');
        return 1;
      }) as never);

      await service.reorder(LIST, { entryIds: ['entry-1'] });

      expect(order).toEqual(['begin', 'lock list', 'read entries', 'renumber', 'read back', 'commit']);
    });

    it("appends the entry after the list's last one, with its platform game, release and note (#1241)", async () => {
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1', gameId: 'game-1' } as never);
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as never);
      db.listEntry.aggregate.mockResolvedValue({ _count: { _all: 3 }, _max: { position: 7 } } as never);

      await service.add(LIST, { platformGameId: 'pg-1', releaseId: 'rel-1', note: '## Why\n\n- co-op' });

      expect(db.listEntry.create).toHaveBeenCalledWith({
        data: { listId: LIST, platformGameId: 'pg-1', releaseId: 'rel-1', note: '## Why\n\n- co-op', position: 8 },
        select: LIST_ENTRY_SELECT,
      });
    });

    it("puts a list's first entry at position 0 (#1241)", async () => {
      await service.add(LIST, { gameId: 'game-1' });

      expect(db.listEntry.create).toHaveBeenCalledWith({
        data: { listId: LIST, gameId: 'game-1', position: 0 },
        select: LIST_ENTRY_SELECT,
      });
    });

    it('refuses a list the actor cannot write with LIST_NOT_FOUND, before reading anything else (#1241)', async () => {
      db.list.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.add(LIST, { gameId: 'game-1' })).rejects.toMatchObject(LIST_NOT_FOUND);
      expect(db.game.findFirst).not.toHaveBeenCalled();
      expect(db.listEntry.create).not.toHaveBeenCalled();
    });

    it('answers not found for a game or platform game deleted between the read and the insert (#1241)', async () => {
      db.listEntry.create.mockRejectedValueOnce(foreignKeyViolation());

      await expect(service.add(LIST, { gameId: 'game-1' })).rejects.toMatchObject(gameNotFound('game-1'));

      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1', gameId: 'game-1' } as never);
      db.listEntry.create.mockRejectedValueOnce(foreignKeyViolation());

      await expect(service.add(LIST, { platformGameId: 'pg-1' })).rejects.toMatchObject(platformGameNotFound('pg-1'));
    });

    it('refuses a release that does not exist as not found (#1241)', async () => {
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1', gameId: 'game-1' } as never);
      db.gameRelease.findUnique.mockResolvedValue(null);

      await expect(service.add(LIST, { platformGameId: 'pg-1', releaseId: 'rel-9' })).rejects.toMatchObject(
        gameReleaseNotFound('rel-9'),
      );
      expect(db.listEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it("writes the patch to the entry within the list, after touching the list's row (#1241)", async () => {
      const order: string[] = [];
      db.list.update.mockImplementation((async () => {
        order.push('lock list');
        return { kind: ListKind.Custom };
      }) as never);
      db.listEntry.update.mockImplementation((async () => {
        order.push('write entry');
        return entryRow({ note: 'Played twice' });
      }) as never);

      const entry = await service.update(LIST, 'entry-1', { note: 'Played twice' });

      expect(order).toEqual(['lock list', 'write entry']);
      expect(db.listEntry.update).toHaveBeenCalledWith({
        where: { id: 'entry-1', listId: LIST },
        data: { note: 'Played twice' },
        select: LIST_ENTRY_SELECT,
      });
      expect(entry.note).toBe('Played twice');
    });

    it("sets a release of the entry's own platform game, and clears one without reading (#1241)", async () => {
      db.listEntry.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as never);
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as never);

      await service.update(LIST, 'entry-1', { releaseId: 'rel-1' });

      expect(db.listEntry.update).toHaveBeenCalledWith(expect.objectContaining({ data: { releaseId: 'rel-1' } }));

      db.listEntry.findUnique.mockClear();
      db.gameRelease.findUnique.mockClear();

      await service.update(LIST, 'entry-1', { releaseId: null, note: null });

      expect(db.listEntry.findUnique).not.toHaveBeenCalled();
      expect(db.gameRelease.findUnique).not.toHaveBeenCalled();
      expect(db.listEntry.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { releaseId: null, note: null } }),
      );
    });

    it('refuses an empty patch with NOTHING_TO_UPDATE (#1241)', async () => {
      await expect(service.update(LIST, 'entry-1', {})).rejects.toMatchObject(NOTHING_TO_UPDATE);
      expect(db.list.update).not.toHaveBeenCalled();
    });

    it('answers LIST_ENTRY_NOT_FOUND for an entry missing from the list (#1241)', async () => {
      db.listEntry.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.update(LIST, 'entry-9', { note: 'x' })).rejects.toMatchObject(ENTRY_NOT_FOUND);

      // The pre-read for a release misses the same way.
      db.listEntry.findUnique.mockResolvedValue(null);

      await expect(service.update(LIST, 'entry-9', { releaseId: 'rel-1' })).rejects.toMatchObject(ENTRY_NOT_FOUND);
    });

    it('refuses a list the actor cannot write with LIST_NOT_FOUND (#1241)', async () => {
      db.list.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.update(LIST, 'entry-1', { note: 'x' })).rejects.toMatchObject(LIST_NOT_FOUND);
      expect(db.listEntry.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it("deletes the entry within the list, after touching the list's row (#1241)", async () => {
      const order: string[] = [];
      db.list.update.mockImplementation((async () => {
        order.push('lock list');
        return { kind: ListKind.Custom };
      }) as never);
      db.listEntry.delete.mockImplementation((async () => {
        order.push('delete entry');
        return entryRow();
      }) as never);

      await service.remove(LIST, 'entry-1');

      expect(order).toEqual(['lock list', 'delete entry']);
      expect(db.listEntry.delete).toHaveBeenCalledWith({ where: { id: 'entry-1', listId: LIST } });
    });

    it('answers LIST_ENTRY_NOT_FOUND for an entry missing from the list (#1241)', async () => {
      db.listEntry.delete.mockRejectedValue(dependentRecordNotFound());

      await expect(service.remove(LIST, 'entry-9')).rejects.toMatchObject(ENTRY_NOT_FOUND);
    });

    // The entry's not-found mapper has the list's shape: any other failure
    // passes through as an Error, a thrown non-Error wrapped in one (#1241).
    it('passes any other write failure through as an Error (#1241)', async () => {
      const boom = new Error('boom');
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      db.listEntry.delete.mockRejectedValueOnce(boom);

      await expect(service.remove(LIST, 'entry-1')).rejects.toBe(boom);

      db.listEntry.delete.mockRejectedValueOnce('not an error');

      await expect(service.remove(LIST, 'entry-1')).rejects.toEqual(new Error('not an error'));
    });

    it('refuses a list the actor cannot write with LIST_NOT_FOUND (#1241)', async () => {
      db.list.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.remove(LIST, 'entry-1')).rejects.toMatchObject(LIST_NOT_FOUND);
      expect(db.listEntry.delete).not.toHaveBeenCalled();
    });
  });

  describe('reorder', () => {
    const held = (...ids: string[]) => ids.map((id) => ({ id }));

    it("refuses a reorder that is not exactly the list's entries with LIST_ORDER_STALE (#1241)", async () => {
      db.listEntry.findMany.mockResolvedValue(held('a', 'b', 'c') as never);

      // Missing one: an entry added since the client loaded the list.
      await expect(service.reorder(LIST, { entryIds: ['a', 'b'] })).rejects.toMatchObject(ORDER_STALE);
      // One too many: an entry removed since.
      await expect(service.reorder(LIST, { entryIds: ['a', 'b', 'c', 'd'] })).rejects.toMatchObject(ORDER_STALE);
      // Another list's entry in place of one of this list's.
      await expect(service.reorder(LIST, { entryIds: ['a', 'b', 'elsewhere'] })).rejects.toMatchObject(ORDER_STALE);
      // The same entry twice.
      await expect(service.reorder(LIST, { entryIds: ['a', 'b', 'c', 'a'] })).rejects.toMatchObject(ORDER_STALE);

      expect(db.listEntry.findMany).toHaveBeenCalledWith({ where: { listId: LIST }, select: { id: true } });
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('writes every position in one statement, renumbering 0..n-1 within the list (#1241)', async () => {
      const reordered = [entryRow({ id: 'c' }), entryRow({ id: 'a' }), entryRow({ id: 'b' })];
      db.listEntry.findMany
        .mockResolvedValueOnce(held('a', 'b', 'c') as never)
        .mockResolvedValueOnce(reordered as never);
      db.$executeRaw.mockResolvedValue(3 as never);

      const entries = await service.reorder(LIST, { entryIds: ['c', 'a', 'b'] });

      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      const [statement] = db.$executeRaw.mock.calls[0] as unknown as [Prisma.Sql];
      expect(rawQueryText(statement)).toBe(
        'UPDATE "list_entries" AS target SET "position" = wanted."position", "updated_at" = ?::timestamptz ' +
          'FROM unnest(?::text[], ?::int[]) AS wanted("id", "position") ' +
          'WHERE target."id" = wanted."id" AND target."list_id" = ?',
      );
      expect(statement.values).toEqual([expect.any(String), ['c', 'a', 'b'], [0, 1, 2], LIST]);
      // The app's clock, as Prisma's @updatedAt stamps it, with its zone, so
      // the cast reads it the same in any session time zone.
      expect(new Date(statement.values[0] as string).toISOString()).toBe(statement.values[0]);
      expect(db.listEntry.update).not.toHaveBeenCalled();

      expect(db.listEntry.findMany).toHaveBeenLastCalledWith({
        where: { listId: LIST },
        select: LIST_ENTRY_SELECT,
        orderBy: ENTRY_ORDER,
      });
      expect(entries).toEqual(reordered);
    });

    it('answers LIST_ORDER_STALE when an entry goes between the check and the renumbering (#1241)', async () => {
      // A game deleted meanwhile takes its entries with it, without the list's lock.
      db.listEntry.findMany.mockResolvedValue(held('a', 'b') as never);
      db.$executeRaw.mockResolvedValue(1 as never);

      await expect(service.reorder(LIST, { entryIds: ['b', 'a'] })).rejects.toMatchObject(ORDER_STALE);
    });

    it('accepts an empty order for an empty list without writing (#1241)', async () => {
      db.listEntry.findMany.mockResolvedValue([]);

      await expect(service.reorder(LIST, { entryIds: [] })).resolves.toEqual([]);
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses a list the actor cannot write with LIST_NOT_FOUND (#1241)', async () => {
      db.list.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.reorder(LIST, { entryIds: [] })).rejects.toMatchObject(LIST_NOT_FOUND);
      expect(db.listEntry.findMany).not.toHaveBeenCalled();
    });
  });
});
