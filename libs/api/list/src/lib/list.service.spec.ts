import { Action, ListKind, Prisma, Reach, ResourceType } from '@bge/database';
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
import { ForbiddenException, Logger } from '@nestjs/common';
import { LISTS_MAX_PER_USER } from './list.constants';
import { ListService } from './list.service';

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Dependent record not found', { code: 'P2025', clientVersion: 'test' });

const COND = { id: 'sentinel-condition' };
const ME = 'user-1';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'list-1',
  userId: ME,
  kind: ListKind.Custom,
  name: 'Top 100',
  description: null,
  reach: Reach.Private,
  position: 0,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  _count: { entries: 3 },
  ...overrides,
});

/** The refusal for a list the actor can't see or write. */
const LIST_NOT_FOUND = { status: 404, code: 'LIST_NOT_FOUND' };

describe('ListService', () => {
  let service: ListService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId' | 'assertCurrentActorCan'>
  >;
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue(ME),
      assertCurrentActorCan: jest.fn(),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        ListService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the routes actually run.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    unwrapTransaction(db);
    service = ctx.module.get(ListService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
  });

  afterEach(() => jest.clearAllMocks());

  describe('listOwn', () => {
    it("lists the acting user's own lists in their chosen order, composed under the list ceiling (#1241)", async () => {
      db.list.findMany.mockResolvedValue([row()]);
      db.list.count.mockResolvedValue(1);

      const page = await service.listOwn(paginationQuery({ limit: 20 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.List, Action.read, { userId: ME });
      expect(db.list.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: ME, AND: [COND] },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        }),
      );
      expect(db.list.count).toHaveBeenCalledWith({ where: { userId: ME, AND: [COND] } });
      expect(page.total).toBe(1);
      expect(page.rows[0]).toMatchObject({ id: 'list-1', entryCount: 3 });
      expect(page.rows[0]).not.toHaveProperty('_count');
    });

    it('reads the rows and the count in one REPEATABLE READ transaction (#1241)', async () => {
      db.list.findMany.mockResolvedValue([]);
      db.list.count.mockResolvedValue(0);

      await service.listOwn(paginationQuery({ limit: 20 }));

      expect(batchTransactionCall(db).options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });
  });

  describe('listForUser', () => {
    it("lists another user's lists under the viewer's ceiling, with that user as the scope (#1241)", async () => {
      db.list.findMany.mockResolvedValue([row({ userId: 'user-2' })]);
      db.list.count.mockResolvedValue(1);

      await service.listForUser('user-2', paginationQuery({ limit: 20 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.List, Action.read, { userId: 'user-2' });
      expect(db.list.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-2', AND: [COND] },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        }),
      );
    });
  });

  describe('getById', () => {
    it('reads one list under the read ceiling and returns it with its entry count (#1241)', async () => {
      db.list.findUnique.mockResolvedValue(row());

      const list = await service.getById('list-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.List, Action.read);
      expect(db.list.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'list-1', AND: [COND] } }),
      );
      expect(list.entryCount).toBe(3);
    });

    it('refuses a list the actor cannot see with LIST_NOT_FOUND (#1241)', async () => {
      db.list.findUnique.mockResolvedValue(null);

      await expect(service.getById('list-9')).rejects.toMatchObject(LIST_NOT_FOUND);
    });
  });

  describe('create', () => {
    it("appends a new list after the acting user's last one (#1241)", async () => {
      db.list.aggregate.mockResolvedValue({ _count: { _all: 2 }, _max: { position: 5 } } as never);
      db.list.create.mockResolvedValue(row({ position: 6 }));

      const list = await service.create({ name: 'Top 100', reach: Reach.Friends });

      expect(db.list.aggregate).toHaveBeenCalledWith({
        where: { userId: ME },
        _count: { _all: true },
        _max: { position: true },
      });
      expect(db.list.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            userId: ME,
            kind: ListKind.Custom,
            name: 'Top 100',
            description: undefined,
            reach: Reach.Friends,
            position: 6,
          },
        }),
      );
      expect(list.position).toBe(6);
    });

    it("puts a user's first custom list after nothing, at position 0 (#1241)", async () => {
      db.list.aggregate.mockResolvedValue({ _count: { _all: 0 }, _max: { position: null } } as never);
      db.list.create.mockResolvedValue(row());

      await service.create({ name: 'Top 100' });

      expect(db.list.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ position: 0 }) }),
      );
    });

    it('checks the list it is about to write against the create conditions, and writes nothing when refused (#1241)', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.create({ name: 'Top 100' })).rejects.toBeInstanceOf(ForbiddenException);

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.List, {
        userId: ME,
        kind: ListKind.Custom,
      });
      expect(db.list.aggregate).not.toHaveBeenCalled();
      expect(db.list.create).not.toHaveBeenCalled();
    });

    it('refuses a list past the per-user limit with LIST_LIMIT_REACHED (#1241)', async () => {
      db.list.aggregate.mockResolvedValue({ _count: { _all: LISTS_MAX_PER_USER }, _max: { position: 199 } } as never);

      await expect(service.create({ name: 'One too many' })).rejects.toMatchObject({
        status: 409,
        code: 'LIST_LIMIT_REACHED',
        response: { limit: LISTS_MAX_PER_USER },
      });
      expect(db.list.create).not.toHaveBeenCalled();
    });

    it('counts and reads the last position inside the same transaction as the insert (#1241)', async () => {
      const order: string[] = [];
      db.$transaction.mockImplementation((async (cb: (tx: MockDatabaseService) => Promise<unknown>) => {
        order.push('begin');
        const result = await cb(db);
        order.push('commit');
        return result;
      }) as never);
      db.list.aggregate.mockImplementation((async () => {
        order.push('aggregate');
        return { _count: { _all: 0 }, _max: { position: null } };
      }) as never);
      db.list.create.mockImplementation((async () => {
        order.push('create');
        return row();
      }) as never);

      await service.create({ name: 'Top 100' });

      expect(order).toEqual(['begin', 'aggregate', 'create', 'commit']);
    });
  });

  describe('update', () => {
    it('writes the given fields under the update ceiling (#1241)', async () => {
      db.list.update.mockResolvedValue(row({ name: 'Renamed' }));

      const list = await service.update('list-1', { name: 'Renamed', reach: Reach.Public });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.List, Action.update);
      expect(db.list.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'list-1', AND: [COND] },
          data: { name: 'Renamed', reach: Reach.Public },
        }),
      );
      expect(list.name).toBe('Renamed');
    });

    it("lets the wishlist's name be cleared and refuses that on a custom list with LIST_NAME_REQUIRED (#1241)", async () => {
      db.list.findUnique.mockResolvedValueOnce({ kind: ListKind.Wishlist } as never);
      db.list.update.mockResolvedValue(row({ kind: ListKind.Wishlist, name: null }));

      await expect(service.update('wish-1', { name: null })).resolves.toMatchObject({ name: null });
      expect(db.list.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: null } }));

      db.list.update.mockClear();
      db.list.findUnique.mockResolvedValueOnce({ kind: ListKind.Custom } as never);

      await expect(service.update('list-1', { name: null })).rejects.toMatchObject({
        status: 400,
        code: 'LIST_NAME_REQUIRED',
      });
      expect(db.list.update).not.toHaveBeenCalled();
    });

    it('reads the list under the update ceiling before clearing a name, and 404s one it cannot see (#1241)', async () => {
      db.list.findUnique.mockResolvedValue(null);

      await expect(service.update('list-9', { name: null })).rejects.toMatchObject(LIST_NOT_FOUND);
      expect(db.list.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'list-9', AND: [COND] } }),
      );
    });

    it('clears a description without a pre-read (#1241)', async () => {
      db.list.update.mockResolvedValue(row());

      await service.update('list-1', { description: null });

      expect(db.list.findUnique).not.toHaveBeenCalled();
      expect(db.list.update).toHaveBeenCalledWith(expect.objectContaining({ data: { description: null } }));
    });

    it('refuses an empty patch with NOTHING_TO_UPDATE (#1241)', async () => {
      await expect(service.update('list-1', {})).rejects.toMatchObject({
        status: 400,
        code: 'NOTHING_TO_UPDATE',
        response: { message: t('common.at_least_one_field') },
      });
      expect(db.list.update).not.toHaveBeenCalled();
    });

    it('maps a missed write to LIST_NOT_FOUND (#1241)', async () => {
      db.list.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.update('list-9', { name: 'x' })).rejects.toMatchObject(LIST_NOT_FOUND);
    });

    it('passes any other write failure through (#1241)', async () => {
      const boom = new Error('boom');
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      db.list.update.mockRejectedValue(boom);

      await expect(service.update('list-1', { name: 'x' })).rejects.toBe(boom);
    });
  });

  describe('remove', () => {
    it('deletes a custom list under the delete ceiling (#1241)', async () => {
      db.list.findUnique.mockResolvedValue({ kind: ListKind.Custom } as never);
      db.list.delete.mockResolvedValue(row());

      await service.remove('list-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.List, Action.delete);
      expect(db.list.delete).toHaveBeenCalledWith({ where: { id: 'list-1', kind: ListKind.Custom, AND: [COND] } });
    });

    it('refuses to delete the wishlist with WISHLIST_UNDELETABLE (#1241)', async () => {
      db.list.findUnique.mockResolvedValue({ kind: ListKind.Wishlist } as never);

      await expect(service.remove('wish-1')).rejects.toMatchObject({ status: 409, code: 'WISHLIST_UNDELETABLE' });
      expect(db.list.delete).not.toHaveBeenCalled();
    });

    it('refuses a list the actor cannot see with LIST_NOT_FOUND (#1241)', async () => {
      db.list.findUnique.mockResolvedValue(null);

      await expect(service.remove('list-9')).rejects.toMatchObject(LIST_NOT_FOUND);
      expect(db.list.delete).not.toHaveBeenCalled();
    });

    it('maps a delete that missed, because the list went in between, to LIST_NOT_FOUND (#1241)', async () => {
      db.list.findUnique.mockResolvedValue({ kind: ListKind.Custom } as never);
      db.list.delete.mockRejectedValue(dependentRecordNotFound());

      await expect(service.remove('list-1')).rejects.toMatchObject(LIST_NOT_FOUND);
    });
  });

  describe('reorder', () => {
    const owned = (...ids: string[]) => ids.map((id) => ({ id }));

    /** The acting user holds `ids`, and the update ceiling admits `writable` of them. */
    const holding = (ids: string[], writable = ids.length) => {
      db.list.findMany.mockResolvedValueOnce(owned(...ids) as never);
      db.list.count.mockResolvedValueOnce(writable);
    };

    const STALE = { status: 409, code: 'LIST_ORDER_STALE' };

    it("refuses a reorder that is not exactly the acting user's lists with LIST_ORDER_STALE, and writes nothing (#1241)", async () => {
      // A missing id.
      holding(['a', 'b', 'c']);
      await expect(service.reorder({ listIds: ['a', 'b'] })).rejects.toMatchObject(STALE);
      // An extra id: one the acting user holds no longer, or never held.
      holding(['a', 'b', 'c']);
      await expect(service.reorder({ listIds: ['a', 'b', 'c', 'd'] })).rejects.toMatchObject(STALE);
      // A stranger's id in place of one of the acting user's.
      holding(['a', 'b', 'c']);
      await expect(service.reorder({ listIds: ['a', 'b', 'stranger'] })).rejects.toMatchObject(STALE);

      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('compares the order with every list the acting user holds, and counts the ones the update ceiling admits (#1241)', async () => {
      holding(['a']);
      db.$executeRaw.mockResolvedValue(1 as never);
      db.list.findMany.mockResolvedValueOnce([row({ id: 'a' })]);

      await service.reorder({ listIds: ['a'] });

      expect(db.list.findMany).toHaveBeenNthCalledWith(1, { where: { userId: ME }, select: { id: true } });
      expect(compose).toHaveBeenCalledWith(ResourceType.List, Action.update, { userId: ME });
      expect(db.list.count).toHaveBeenCalledWith({ where: { userId: ME, AND: [COND] } });
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    // An API key whose update:list grant is pinned to one list passes the
    // route's policy check, but renumbering only that list would give it a
    // position another list already holds.
    it('refuses a caller who may change only some of the lists with LIST_ORDER_FORBIDDEN, and writes nothing (#1241)', async () => {
      holding(['wishlist', 'pinned', 'other'], 1);

      await expect(service.reorder({ listIds: ['pinned'] })).rejects.toMatchObject({
        status: 403,
        code: 'LIST_ORDER_FORBIDDEN',
      });
      // Even an order naming every list: the caller still can't change two of them.
      holding(['wishlist', 'pinned', 'other'], 1);
      await expect(service.reorder({ listIds: ['other', 'pinned', 'wishlist'] })).rejects.toMatchObject({
        code: 'LIST_ORDER_FORBIDDEN',
      });

      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it("writes every position in one statement, renumbering 0..n-1 within the acting user's lists (#1241)", async () => {
      const reordered = [row({ id: 'c', position: 0 }), row({ id: 'a', position: 1 }), row({ id: 'b', position: 2 })];
      holding(['a', 'b', 'c']);
      db.$executeRaw.mockResolvedValue(3 as never);
      db.list.findMany.mockResolvedValueOnce(reordered);

      const lists = await service.reorder({ listIds: ['c', 'a', 'b'] });

      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      const [statement] = db.$executeRaw.mock.calls[0] as unknown as [Prisma.Sql];
      expect(rawQueryText(statement)).toBe(
        'UPDATE "lists" AS target SET "position" = wanted."position", "updated_at" = ?::timestamptz ' +
          'FROM unnest(?::text[], ?::int[]) AS wanted("id", "position") ' +
          'WHERE target."id" = wanted."id" AND target."user_id" = ?',
      );
      expect(statement.values).toEqual([expect.any(String), ['c', 'a', 'b'], [0, 1, 2], ME]);
      expect(new Date(statement.values[0] as string).toISOString()).toBe(statement.values[0]);
      expect(db.list.update).not.toHaveBeenCalled();

      // The reply is the lists it reordered, read back in their new order.
      expect(db.list.findMany).toHaveBeenLastCalledWith({
        where: { userId: ME, id: { in: ['c', 'a', 'b'] } },
        select: expect.any(Object),
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      expect(lists.map(({ id, position }) => [id, position])).toEqual([
        ['c', 0],
        ['a', 1],
        ['b', 2],
      ]);
    });

    it('answers LIST_ORDER_STALE when a list is deleted between the check and the renumbering (#1241)', async () => {
      holding(['a', 'b']);
      db.$executeRaw.mockResolvedValue(1 as never);

      await expect(service.reorder({ listIds: ['b', 'a'] })).rejects.toMatchObject(STALE);
    });

    it('passes a failed renumbering through (#1241)', async () => {
      const boom = new Error('boom');
      holding(['a', 'b']);
      db.$executeRaw.mockRejectedValue(boom);

      await expect(service.reorder({ listIds: ['b', 'a'] })).rejects.toBe(boom);
    });

    it('accepts an empty order for an acting user with no lists, without writing (#1241)', async () => {
      holding([]);
      db.list.findMany.mockResolvedValueOnce([]);

      await expect(service.reorder({ listIds: [] })).resolves.toEqual([]);
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
