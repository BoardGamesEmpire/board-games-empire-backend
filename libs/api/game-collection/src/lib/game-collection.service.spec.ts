import type { GameCollection, GameRelease, PlatformGame } from '@bge/database';
import {
  Action,
  ContentType,
  GameMedium,
  GameRemovalReason,
  ListKind,
  Prisma,
  Reach,
  ResourceType,
} from '@bge/database';
import type { CollectionSupplyChange } from '@bge/event';
import { emitCollectionSupplyChanges, syncCollectionEntrySupply } from '@bge/event';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  rawQueryText,
  unwrapTransaction,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { COLLECTION_INCLUDE } from './collection-row';
import { GameCollectionService } from './game-collection.service';

// The supply sync has its own spec in `@bge/event`; here it is a seam, so the
// tests below pin when a removal or an add-back runs it and what they pass
// (#1221).
jest.mock('@bge/event', () => ({
  syncCollectionEntrySupply: jest.fn(),
  emitCollectionSupplyChanges: jest.fn(),
}));

const syncSupply = jest.mocked(syncCollectionEntrySupply);
const emitSupply = jest.mocked(emitCollectionSupplyChanges);

/** What the sync changed in one event, as a removal or an add-back hands it to the emit (#1221). */
const SUPPLY_CHANGES: CollectionSupplyChange[] = [
  { eventId: 'ev-1', changes: { paused: [], resumed: [], removedGames: [] } },
];

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Dependent record not found', { code: 'P2025', clientVersion: 'test' });

const COND = { id: 'sentinel-condition' };
const ME = 'user-1';

const entry = (overrides: Partial<GameCollection> = {}): GameCollection =>
  ({
    id: 'gc-1',
    userId: ME,
    platformGameId: 'pg-1',
    releaseId: null,
    medium: GameMedium.Physical,
    quantity: 1,
    reach: Reach.Private,
    rating: null,
    playCount: 3,
    playAgain: true,
    favorite: true,
    comment: null,
    lastPlayed: new Date('2026-01-01'),
    lastUpdated: null,
    deletedAt: null,
    deleteReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    // Of the embedded rows, the service reads the platform game's id, which
    // keys the base-game link read, its platform, which picks the base games
    // on it, and the content types, which decide each link's isStandalone
    // (#1070, #1391).
    platformGame: inView('pg-1', 'g-1'),
  }) as GameCollection;

/**
 * A platform game as the collection include returns it, of the game `gameId`,
 * a standalone expansion, on `platformId` with no content type of its own
 * unless given (#1391).
 */
function inView(id: string, gameId: string, platformId = 'plat-1', contentType: ContentType | null = null) {
  return {
    id,
    contentType,
    platform: { id: platformId },
    game: { id: gameId, contentType: ContentType.StandaloneExpansion },
  };
}

/** An entry on the game `gameId`, a standalone expansion, as the collection include returns it (#1070). */
const entryOn = (gameId: string, overrides: Partial<GameCollection> = {}): GameCollection =>
  ({ ...entry(overrides), platformGame: inView(`pg-${gameId}`, gameId) }) as GameCollection;

/** The refusal for a collection entry the actor can't see, whatever the reason (#634). */
const ENTRY_NOT_FOUND = {
  status: 404,
  code: 'COLLECTION_ENTRY_NOT_FOUND',
  response: { statusCode: 404, error: 'Not Found', code: 'COLLECTION_ENTRY_NOT_FOUND' },
};

describe('GameCollectionService', () => {
  let service: GameCollectionService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId' | 'getCurrentAccess'>
  >;
  let compose: jest.SpyInstance;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue(ME),
      // The actor can read lists, unless a spec says otherwise (#1241).
      getCurrentAccess: jest.fn().mockReturnValue({ [ResourceType.List]: { [Action.read]: 'some' } }),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        GameCollectionService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the lists actually run.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    });

    db = ctx.db;
    // A removal and an add-back write in a callback transaction, the list
    // reads in a batch one; the mock runs both (#1221).
    unwrapTransaction(db);
    syncSupply.mockResolvedValue([]);
    // Each read that returns rows also reads their base-game links (#1070).
    db.gameExpansion.findMany.mockResolvedValue([]);
    // The actor's wishlist is readable, unless a spec says otherwise (#1241).
    db.list.findFirst.mockResolvedValue({ id: 'wishlist-1' } as never);
    db.listEntry.findMany.mockResolvedValue([]);
    service = ctx.module.get(GameCollectionService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * Records a callback transaction's start as `begin` and its commit as
   * `commit` in `order`, running the callback against the mock, so a test can
   * pin which writes run inside it and that the emit waits for the commit
   * (#1221).
   */
  function recordTransaction(order: string[]): void {
    db.$transaction.mockImplementation((async (operations: unknown) => {
      if (Array.isArray(operations)) {
        return Promise.all(operations);
      }

      order.push('begin');
      const result = await (operations as (tx: MockDatabaseService) => Promise<unknown>)(db);
      order.push('commit');

      return result;
    }) as never);
  }

  /**
   * #514. `GET /game-collections` declares its own set, the acting user's
   * entries, and the ceiling only clips it. It already filtered on `userId`, so
   * no caller's rows change; what changes is that a later edit cannot drop the
   * scope without the envelope noticing. `GameCollection`'s envelope is
   * guarded, so a read that stops composing answers 500 at the
   * envelope rather than widening to whatever the ceiling admits, which for
   * staff is every entry on the server. That is why the first test pins the
   * composer call itself.
   */
  describe('listOwn', () => {
    it("asks the composer for its where clause, declaring the acting user's entries", async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listOwn(paginationQuery({ limit: 20 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.GameCollection, Action.read, { userId: ME });
    });

    // A platform game's own content type is one of its overrides, so a row
    // sends it beside its players, play time and images, a value or null
    // (#1391).
    it("sends the platform game's own content type beside its other overrides (#1391)", () => {
      expect(COLLECTION_INCLUDE.platformGame.select).toMatchObject({
        image: true,
        thumbnail: true,
        minPlayers: true,
        maxPlayers: true,
        minPlayTime: true,
        maxPlayTime: true,
        contentType: true,
      });
    });

    // The tombstone, medium, favourite and date filters are caller input, not
    // scope, so they sit beside the composed clause rather than inside it.
    it('queries with the composed clause, its filters beside it, and excludes tombstones by default', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listOwn(paginationQuery({ limit: 20 }));

      expect(db.gameCollection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [{ userId: ME, AND: [COND] }, { deletedAt: null }] },
        }),
      );
    });

    it('includeDeleted lifts the tombstone filter', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listOwn(Object.assign(paginationQuery({ limit: 20 }), { includeDeleted: true }));

      expect(db.gameCollection.findMany.mock.calls[0][0]?.where).toEqual({ AND: [{ userId: ME, AND: [COND] }, {}] });
    });

    it('deletedOnly returns the resurrection view', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listOwn(Object.assign(paginationQuery({ limit: 20 }), { deletedOnly: true }));

      expect(db.gameCollection.findMany.mock.calls[0][0]?.where).toEqual({
        AND: [{ userId: ME, AND: [COND] }, { deletedAt: { not: null } }],
      });
    });

    // PROVISIONAL (#395). "My collection" has no meaning for an actor with no
    // user behind it. The refusal predates the sweep; what the sweep changes is
    // its message, which is now the read's own rather than one about writes.
    it('refuses an actor kind with no user behind it, with a message about reading', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await service.listOwn(paginationQuery({ limit: 20 })).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.gameCollection.findMany).not.toHaveBeenCalled();
    });

    // The count is what `pagination.total` reports, so it must carry the SAME
    // scope as the rows: a count over a wider `where` inflates the total, and a
    // client pages towards rows it will never be shown (#230).
    it('counts over the same scope it reads, and returns that as the total', async () => {
      // One row instance, stubbed and asserted: `entry()` stamps createdAt and
      // updatedAt with `new Date()`, so a second call yields a row that differs
      // from the stubbed one whenever the two straddle a millisecond.
      const row = entry();
      db.gameCollection.findMany.mockResolvedValue([row]);
      db.gameCollection.count.mockResolvedValue(37);

      const page = await service.listOwn(Object.assign(paginationQuery({ limit: 20 }), { medium: GameMedium.Digital }));

      expect(db.gameCollection.count).toHaveBeenCalledWith({
        where: db.gameCollection.findMany.mock.calls[0][0]?.where,
      });
      expect(page).toEqual({ rows: [expect.objectContaining({ id: row.id })], total: 37 });
    });

    // The count only agrees with the rows because both read one snapshot, and
    // the transaction mock resolves the operation array at any isolation level —
    // so the guarantee has to be pinned or it can regress silently.
    it('reads the rows and the count in one REPEATABLE READ transaction', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);
      db.gameCollection.count.mockResolvedValue(0);

      await service.listOwn(paginationQuery({ limit: 20 }));

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    describe('with updatedSince (#1070)', () => {
      const since = new Date('2026-06-01');
      const query = () =>
        Object.assign(paginationQuery({ limit: 20 }), {
          medium: GameMedium.Digital,
          favorite: false,
          updatedSince: since,
        });

      // The catch-up drain resends a row when the entry changed or a value it
      // embeds did: the platform game, its platform, the game, the game's links
      // as an expansion, those links' base games and their platform games
      // (#1391), and the release. Written out rather than built from the code
      // under test, so a dropped arm fails here.
      const changedSinceShape = {
        OR: [
          { updatedAt: { gte: since } },
          {
            platformGame: {
              is: {
                OR: [
                  { updatedAt: { gte: since } },
                  { platform: { is: { updatedAt: { gte: since } } } },
                  {
                    game: {
                      is: {
                        OR: [
                          { updatedAt: { gte: since } },
                          {
                            expansionEntries: {
                              some: {
                                OR: [
                                  { updatedAt: { gte: since } },
                                  { baseGame: { is: { updatedAt: { gte: since } } } },
                                  // A base game gaining a platform game can add
                                  // it to a row on that platform (#1391).
                                  { baseGame: { is: { platformGames: { some: { updatedAt: { gte: since } } } } } },
                                ],
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
          { release: { is: { updatedAt: { gte: since } } } },
        ],
      };

      it('applies the medium and favorite filters, and resends a row whose entry or embedded values changed', async () => {
        db.gameCollection.findMany.mockResolvedValue([]);

        await service.listOwn(query());

        expect(db.gameCollection.findMany.mock.calls[0][0]?.where).toEqual({
          AND: [
            { userId: ME, AND: [COND] },
            { deletedAt: null, medium: GameMedium.Digital, favorite: false, ...changedSinceShape },
          ],
        });
      });

      it('counts over the same changed-since where it reads', async () => {
        db.gameCollection.findMany.mockResolvedValue([]);
        db.gameCollection.count.mockResolvedValue(0);

        await service.listOwn(query());

        expect(db.gameCollection.count).toHaveBeenCalledWith({
          where: db.gameCollection.findMany.mock.calls[0][0]?.where,
        });
      });
    });
  });

  /**
   * #514. `GET /users/:userId/game-collections` declares the path user's live
   * entries, and the viewer's ceiling decides which of them they may see:
   * household-shared, friend-shared and public for a signed-in viewer, public
   * only for a guest. Composing changes no rows, since the read already
   * filtered on `userId`; it is the envelope guard's precondition.
   */
  describe('listForUser', () => {
    it("asks the composer for its where clause, declaring the path user's live entries", async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listForUser('user-2', paginationQuery({ limit: 20 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.GameCollection, Action.read, {
        userId: 'user-2',
        deletedAt: null,
      });
    });

    it("queries with the composed clause, the viewer's ceiling clipping the path user's entries", async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listForUser('user-2', paginationQuery({ limit: 20 }));

      expect(db.gameCollection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [{ userId: 'user-2', deletedAt: null, AND: [COND] }, {}] },
        }),
      );
    });

    // The medium filter is caller input, so it sits beside the scope.
    it('applies the medium filter beside the composed clause', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listForUser(
        'user-2',
        Object.assign(paginationQuery({ limit: 20 }), { medium: GameMedium.Digital }),
      );

      expect(db.gameCollection.findMany.mock.calls[0][0]?.where).toEqual({
        AND: [{ userId: 'user-2', deletedAt: null, AND: [COND] }, { medium: GameMedium.Digital }],
      });
    });

    // The viewer need not be a user: a guest reads Public entries through its
    // own role (#484), so this read must not ask who the viewer is.
    it('does not require the viewer to be a user', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);
      db.gameCollection.count.mockResolvedValue(0);
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      await expect(service.listForUser('user-2', paginationQuery({ limit: 20 }))).resolves.toEqual({
        rows: [],
        total: 0,
      });
    });

    it("counts the viewer-visible scope, not the target user's whole collection", async () => {
      db.gameCollection.findMany.mockResolvedValue([]);
      db.gameCollection.count.mockResolvedValue(4);

      const page = await service.listForUser('user-2', paginationQuery({ limit: 20 }));

      expect(db.gameCollection.count).toHaveBeenCalledWith({
        where: db.gameCollection.findMany.mock.calls[0][0]?.where,
      });
      expect(page.total).toBe(4);
    });

    it('refuses a caller the ability layer refuses, rather than falling back to Public entries', async () => {
      // No Public-only fallback any more (#484): anonymous callers read through
      // their own role, and a refusal has to reach the client.
      abilityService.getCurrentResourceConditions.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.listForUser('user-2', paginationQuery({ limit: 20 }))).rejects.toThrow(ForbiddenException);
      expect(db.gameCollection.findMany).not.toHaveBeenCalled();
    });
  });

  /**
   * #1241. A row of another user's collection says whether its game is on the
   * acting user's wishlist, so a client can show "a friend's copy of a game you
   * want". `listOwn` and the write paths leave the field out.
   */
  describe("onWishlist on another user's collection (#1241)", () => {
    it("says which of another user's entries are on the acting user's wishlist (#1241)", async () => {
      db.gameCollection.findMany.mockResolvedValue([
        entryOn('g-1', { id: 'gc-1' }),
        entryOn('g-2', { id: 'gc-2' }),
        entryOn('g-3', { id: 'gc-3' }),
      ]);
      db.gameCollection.count.mockResolvedValue(3);
      // g-1 is wishlisted as a game, g-2's platform game directly, g-3 not at all.
      db.listEntry.findMany.mockResolvedValue([
        { gameId: 'g-1', platformGameId: null },
        { gameId: null, platformGameId: 'pg-g-2' },
      ] as never);

      const page = await service.listForUser('user-2', paginationQuery({ limit: 20 }));

      expect(page.rows.map((row) => row.onWishlist)).toEqual([true, true, false]);
      expect(compose).toHaveBeenCalledWith(ResourceType.List, Action.read, { userId: ME, kind: ListKind.Wishlist });
      // The ceiling-composed wishlist read is top-level; the entry read names
      // the wishlist it found by id.
      expect(db.list.findFirst).toHaveBeenCalledWith({
        where: { userId: ME, kind: ListKind.Wishlist, AND: [COND] },
        select: { id: true },
      });
      expect(db.listEntry.findMany).toHaveBeenCalledTimes(1);
      expect(db.listEntry.findMany.mock.calls[0][0]?.where).toMatchObject({ listId: 'wishlist-1' });
    });

    it('answers null, not false, for an actor who cannot read a wishlist (#1241)', async () => {
      db.gameCollection.findMany.mockResolvedValue([entryOn('g-1')]);
      db.gameCollection.count.mockResolvedValue(1);

      // No acting user: a plugin, system or external actor.
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });
      const noUser = await service.listForUser('user-2', paginationQuery({ limit: 20 }));
      expect(noUser.rows.map((row) => row.onWishlist)).toEqual([null]);

      // A user, but with no list read: an anonymous user, or a key without a list grant.
      abilityService.getActingUserId.mockReturnValue(ME);
      abilityService.getCurrentAccess.mockReturnValue({ [ResourceType.List]: { [Action.read]: 'none' } } as never);
      const noListRead = await service.listForUser('user-2', paginationQuery({ limit: 20 }));
      expect(noListRead.rows.map((row) => row.onWishlist)).toEqual([null]);

      expect(db.list.findFirst).not.toHaveBeenCalled();
      expect(db.listEntry.findMany).not.toHaveBeenCalled();
    });

    // List read access that doesn't reach the wishlist: a key whose list grant
    // is pinned to one custom list, or a user with no wishlist row. The access
    // check passes, the wishlist read finds nothing, and "not yours to know"
    // must not read as "not on your wishlist" (#1241).
    it('answers null, not false, when list read access does not reach the wishlist (#1241)', async () => {
      db.gameCollection.findMany.mockResolvedValue([entryOn('g-1', { id: 'gc-1' }), entryOn('g-2', { id: 'gc-2' })]);
      db.gameCollection.count.mockResolvedValue(2);
      db.list.findFirst.mockResolvedValue(null);

      const page = await service.listForUser('user-2', paginationQuery({ limit: 20 }));

      expect(page.rows.map((row) => row.onWishlist)).toEqual([null, null]);
      expect(db.list.findFirst).toHaveBeenCalledTimes(1);
      expect(db.listEntry.findMany).not.toHaveBeenCalled();
    });

    it("leaves the field off the acting user's own collection (#1241)", async () => {
      db.gameCollection.findMany.mockResolvedValue([entryOn('g-1')]);
      db.gameCollection.count.mockResolvedValue(1);

      const page = await service.listOwn(paginationQuery({ limit: 20 }));

      expect(page.rows[0]).not.toHaveProperty('onWishlist');
      expect(db.listEntry.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('returns a readable entry', async () => {
      db.gameCollection.findUnique.mockResolvedValue(entry());

      await expect(service.getById('gc-1')).resolves.toMatchObject({ id: 'gc-1' });
      expect(db.gameCollection.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'gc-1', AND: [COND] }) }),
      );
    });

    it('404s when the entry is not visible to the actor, naming the collection entry (#634)', async () => {
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.getById('gc-404')).rejects.toMatchObject(ENTRY_NOT_FOUND);
    });
  });

  describe('addToCollection', () => {
    /** The upsert's answer for a genuine create: the row under the id the service minted (#1221). */
    const created = (async ({ create }: { create: { id: string } }) => entry({ id: create.id })) as never;

    beforeEach(() => {
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1' } as PlatformGame);
      db.gameCollection.upsert.mockImplementation(created);
    });

    it('404s when the platform game does not exist', async () => {
      db.platformGame.findUnique.mockResolvedValue(null);

      await expect(service.addToCollection({ platformGameId: 'pg-404', medium: GameMedium.Physical })).rejects.toThrow(
        NotFoundException,
      );
      expect(db.gameCollection.upsert).not.toHaveBeenCalled();
    });

    it('upserts on the (user, platformGame, medium) identity', async () => {
      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, quantity: 2 });

      expect(db.gameCollection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_platformGameId_medium: { userId: ME, platformGameId: 'pg-1', medium: GameMedium.Physical } },
          create: expect.objectContaining({ id: expect.any(String), userId: ME, platformGameId: 'pg-1', quantity: 2 }),
        }),
      );
    });

    it('resurrects a tombstoned entry without touching play history', async () => {
      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      const { update } = db.gameCollection.upsert.mock.calls[0][0];
      expect(update).toMatchObject({ deletedAt: null, deleteReason: null });
      // Server-managed play history and unspecified fields must survive the cycle.
      expect(update).not.toHaveProperty('playCount');
      expect(update).not.toHaveProperty('lastPlayed');
      expect(update).not.toHaveProperty('favorite');
      expect(update).not.toHaveProperty('playAgain');
    });

    // The add-back locks the entry's row before it writes, and that lock is
    // the transaction's first, so a nomination naming the entry, or its
    // attendee coming back, takes turns with it. The transaction keeps the
    // default isolation, READ COMMITTED, so each statement of the sync reads
    // what had committed when it started (#1221).
    it('addToCollection of a removed entry locks the row, clears the removal and resumes its offers (#1221)', async () => {
      const order: string[] = [];
      recordTransaction(order);
      db.$queryRaw.mockImplementation((async () => {
        order.push('lock');
        return [{ deletedAt: new Date('2026-11-01') }];
      }) as never);
      db.gameCollection.upsert.mockImplementation((async () => {
        order.push('upsert');
        return entry();
      }) as never);
      syncSupply.mockImplementation(async () => {
        order.push('sync');
        return SUPPLY_CHANGES;
      });
      emitSupply.mockImplementation(() => {
        order.push('emit');
      });

      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      const [lock] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
      expect(rawQueryText(lock)).toBe(
        'SELECT deleted_at AS "deletedAt" FROM game_collections WHERE user_id = ? AND platform_game_id = ? AND medium = ?::game_mediums FOR UPDATE',
      );
      expect(lock.values).toEqual([ME, 'pg-1', GameMedium.Physical]);

      const { update } = db.gameCollection.upsert.mock.calls[0][0];
      expect(update).toMatchObject({ deletedAt: null, deleteReason: null });
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: null }, update.lastUpdated);
      expect(emitSupply).toHaveBeenCalledWith(eventEmitter, SUPPLY_CHANGES, ME, update.lastUpdated);
      expect(order).toEqual(['begin', 'lock', 'upsert', 'sync', 'commit', 'emit']);
      expect(db.$transaction.mock.calls[0]).toHaveLength(1);
    });

    // The pre-read found no row, but another request created one before the
    // upsert, which then updates that row rather than creating its own: its
    // id is not the one minted here. The row may have been removed in that
    // window, so the sync reads it as the add-back leaves it, live. The
    // upsert's UPDATE is the first lock on it (#1221).
    it('addToCollection of an entry another request created after its pre-read resumes its offers (#1221)', async () => {
      const order: string[] = [];
      recordTransaction(order);
      db.$queryRaw.mockImplementation((async () => {
        order.push('lock');
        return [];
      }) as never);
      db.gameCollection.upsert.mockImplementation((async () => {
        order.push('upsert');
        return entry({ id: 'gc-other' });
      }) as never);
      syncSupply.mockImplementation(async () => {
        order.push('sync');
        return SUPPLY_CHANGES;
      });
      emitSupply.mockImplementation(() => {
        order.push('emit');
      });

      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      const { update } = db.gameCollection.upsert.mock.calls[0][0];
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-other', deletedAt: null }, update.lastUpdated);
      expect(emitSupply).toHaveBeenCalledWith(eventEmitter, SUPPLY_CHANGES, ME, update.lastUpdated);
      expect(order).toEqual(['begin', 'lock', 'upsert', 'sync', 'commit', 'emit']);
    });

    // A plain add locks the entry's row too, but has no paused offers to
    // resume, so it reads no event and emits nothing. A genuine create
    // answers the id it was given (#1221).
    it.each([
      ['a new entry', [], created],
      ['a live entry', [{ deletedAt: null }], (async () => entry()) as never],
    ])('addToCollection of a new or live entry runs no sync (#1221): %s', async (_, locked, answer) => {
      const order: string[] = [];
      recordTransaction(order);
      db.$queryRaw.mockImplementation((async () => {
        order.push('lock');
        return locked;
      }) as never);
      db.gameCollection.upsert.mockImplementation((async (args: never) => {
        order.push('upsert');
        return (answer as (args: never) => Promise<GameCollection>)(args);
      }) as never);

      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      expect(order).toEqual(['begin', 'lock', 'upsert', 'commit']);
      expect(syncSupply).not.toHaveBeenCalled();
      expect(emitSupply).not.toHaveBeenCalled();
    });

    it('404s when the release does not exist', async () => {
      db.gameRelease.findUnique.mockResolvedValue(null);

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, releaseId: 'r-404' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('400s when the release belongs to a different platform game', async () => {
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-other' } as GameRelease);

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, releaseId: 'r-1' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      db.gameCollection.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameCollection);
      db.gameCollection.update.mockResolvedValue(entry());
    });

    it('rejects an empty patch', async () => {
      await expect(service.update('gc-1', {})).rejects.toThrow(BadRequestException);
      expect(db.gameCollection.update).not.toHaveBeenCalled();
    });

    it('goes straight to the scoped update without a pre-read', async () => {
      await service.update('gc-1', { quantity: 2 });

      expect(db.gameCollection.findUnique).not.toHaveBeenCalled();
    });

    it('404s when the entry does not exist (or is not the actor’s), naming the collection entry (#634)', async () => {
      db.gameCollection.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.update('gc-404', { quantity: 2 })).rejects.toMatchObject(ENTRY_NOT_FOUND);
    });

    it('passes explicit nulls through to clear nullable fields', async () => {
      await service.update('gc-1', { rating: null, comment: null, quantity: 2 });

      expect(db.gameCollection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'gc-1', AND: [COND] }),
          data: expect.objectContaining({ rating: null, comment: null, quantity: 2 }),
        }),
      );
    });

    it('omits fields the caller did not send', async () => {
      await service.update('gc-1', { favorite: true });

      const { data } = db.gameCollection.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('rating');
      expect(data).not.toHaveProperty('comment');
      expect(data).not.toHaveProperty('quantity');
    });

    it('validates a new release against the entry’s platform game (scoped pre-read)', async () => {
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-other' } as GameRelease);

      await expect(service.update('gc-1', { releaseId: 'r-1' })).rejects.toThrow(BadRequestException);
      expect(db.gameCollection.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'gc-1', AND: [COND] }) }),
      );
    });

    it('404s a release patch on a row outside the actor’s scope', async () => {
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.update('gc-1', { releaseId: 'r-1' })).rejects.toMatchObject(ENTRY_NOT_FOUND);
      expect(db.gameCollection.update).not.toHaveBeenCalled();
    });

    it('uses update conditions, not read conditions, for the write', async () => {
      await service.update('gc-1', { quantity: 2 });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.update,
      );
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      db.gameCollection.update.mockResolvedValue(entry({ deletedAt: new Date() }));
    });

    it('soft deletes with an optional reason in a single scoped write', async () => {
      await service.remove('gc-1', { reason: GameRemovalReason.Sold });

      expect(db.gameCollection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'gc-1', deletedAt: null, AND: [COND] }),
          data: expect.objectContaining({ deletedAt: expect.any(Date), deleteReason: GameRemovalReason.Sold }),
        }),
      );
      // Never a hard delete — play history and child rows must survive.
      expect(db.gameCollection.delete).not.toHaveBeenCalled();
      // No pre-read: the `deletedAt: null` filter carries the state check.
      expect(db.gameCollection.findUnique).not.toHaveBeenCalled();
    });

    it('defaults the reason to null', async () => {
      await service.remove('gc-1', {});

      expect(db.gameCollection.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deleteReason: null }) }),
      );
    });

    // A client reads this 404 as "already removed" and completes its queued
    // removal, so it must be told apart from a route that moved (#634).
    it('404s missing, already-removed, and foreign rows alike, naming the collection entry (#634)', async () => {
      db.gameCollection.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.remove('gc-404', {})).rejects.toMatchObject(ENTRY_NOT_FOUND);
    });

    // The removal's `UPDATE` is the transaction's first lock, on the entry's
    // row, and the sync reads the state written under it. The emit waits for
    // the commit, so no listener hears of a pause that rolled back (#1221).
    it("remove runs the supply sync in the removal's transaction with the removed row, and emits after it commits (#1221)", async () => {
      const order: string[] = [];
      recordTransaction(order);
      db.gameCollection.update.mockImplementation((async () => {
        order.push('update');
        return entry({ deletedAt: new Date() });
      }) as never);
      syncSupply.mockImplementation(async () => {
        order.push('sync');
        return SUPPLY_CHANGES;
      });
      emitSupply.mockImplementation(() => {
        order.push('emit');
      });

      // The owner's answer is the removed entry, whatever the sync changed (#1221).
      expect(await service.remove('gc-1', {})).toMatchObject({ id: 'gc-1', deletedAt: expect.any(Date) });

      const { data } = db.gameCollection.update.mock.calls[0][0];
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: data.deletedAt }, data.deletedAt);
      expect(emitSupply).toHaveBeenCalledWith(eventEmitter, SUPPLY_CHANGES, ME, data.deletedAt);
      expect(order).toEqual(['begin', 'update', 'sync', 'commit', 'emit']);
      // The default isolation, READ COMMITTED: the sync relies on each of its
      // statements reading what had committed when it started (#1221).
      expect(db.$transaction.mock.calls[0]).toHaveLength(1);
    });

    // The scoped update misses, the transaction rolls back, and the client
    // still reads the 404 as "already removed" (#634, #1221).
    it('remove of an entry already removed answers 404 and syncs nothing (#1221)', async () => {
      db.gameCollection.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.remove('gc-1', {})).rejects.toMatchObject(ENTRY_NOT_FOUND);
      expect(syncSupply).not.toHaveBeenCalled();
      expect(emitSupply).not.toHaveBeenCalled();
    });

    // The emit runs after the removal committed, so an actor with no user
    // behind it is named as nobody rather than refused then (#1221).
    it('remove by an actor with no user emits its changes as nobody’s (#1221)', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });
      syncSupply.mockResolvedValue(SUPPLY_CHANGES);

      await service.remove('gc-1', {});

      expect(emitSupply).toHaveBeenCalledWith(eventEmitter, SUPPLY_CHANGES, null, expect.any(Date));
    });

    it('uses delete conditions for the write', async () => {
      await service.remove('gc-1', {});

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.delete,
      );
    });
  });

  /**
   * #1070. A row names its game's base games that are live and that the viewer
   * could open by id, the rule `GET /games/:id` uses. The filter sits in the
   * `where` of a link read of its own: in the collection include Prisma would
   * drop a deny-all and name every base game.
   */
  describe('base games on collection rows (#1070)', () => {
    // The link carries no isStandalone: each row's `true` below comes from its
    // game's content type, a standalone expansion. Its base game has a
    // platform game on the rows' platform, so the rows name it (#1391).
    const LINK = { expansionGameId: 'g-1', baseGameId: 'b-1', baseGame: { platformGames: [{ platformId: 'plat-1' }] } };

    // The real composer over the mocked ability: the live games under the
    // viewer's read ceiling.
    const LIVE_GAMES_THE_VIEWER_COULD_OPEN = { deletedAt: null, AND: [COND] };

    /** The base game's platform games, read on the page's platforms only (#1391). */
    const basePlatformGamesOn = (platformIds: string[]) => ({
      baseGame: {
        select: { platformGames: { where: { platformId: { in: platformIds } }, select: { platformId: true } } },
      },
    });

    const singleRowReads = {
      getById: () => service.getById('gc-1'),
      addToCollection: () => service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical }),
      update: () => service.update('gc-1', { quantity: 2 }),
      remove: () => service.remove('gc-1', {}),
    } as const;

    beforeEach(() => {
      db.gameExpansion.findMany.mockResolvedValue([LINK] as never);
      db.gameCollection.count.mockResolvedValue(1);
      db.gameCollection.findUnique.mockResolvedValue(entryOn('g-1'));
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1' } as PlatformGame);
      db.gameCollection.upsert.mockResolvedValue(entryOn('g-1'));
      db.gameCollection.update.mockResolvedValue(entryOn('g-1'));
    });

    it('names each row’s base games through one link read, over the live games the viewer could open by id', async () => {
      db.gameCollection.findMany.mockResolvedValue([entryOn('g-1')]);

      const page = await service.listOwn(paginationQuery({ limit: 20 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, { deletedAt: null });
      expect(db.gameExpansion.findMany).toHaveBeenCalledTimes(1);
      expect(db.gameExpansion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { expansionGameId: { in: ['g-1'] }, baseGame: { is: LIVE_GAMES_THE_VIEWER_COULD_OPEN } },
          select: expect.objectContaining(basePlatformGamesOn(['plat-1'])),
        }),
      );
      expect(page.rows[0]?.platformGame.game.baseGames).toEqual([{ gameId: 'b-1', isStandalone: true }]);
    });

    // One game held on two platforms gives two rows. Each lists the base games
    // with a platform game on its own platform, so the links are keyed by
    // platform game, never by game (#1391).
    it('gives each platform game of one game the base games on its own platform (#1391)', async () => {
      db.gameCollection.findMany.mockResolvedValue([
        { ...entry({ id: 'gc-1' }), platformGame: inView('pg-tabletop', 'g-1', 'plat-1') } as GameCollection,
        { ...entry({ id: 'gc-2' }), platformGame: inView('pg-pc', 'g-1', 'plat-pc') } as GameCollection,
      ]);

      const page = await service.listOwn(paginationQuery({ limit: 20 }));

      expect(db.gameExpansion.findMany).toHaveBeenCalledTimes(1);
      expect(db.gameExpansion.findMany.mock.calls[0][0]).toMatchObject({
        where: { expansionGameId: { in: ['g-1'] } },
        select: basePlatformGamesOn(['plat-1', 'plat-pc']),
      });
      expect(page.rows.map((row) => [row.id, row.platformGame.game.baseGames])).toEqual([
        ['gc-1', [{ gameId: 'b-1', isStandalone: true }]],
        ['gc-2', []],
      ]);
    });

    // A platform game's own content type overrides its game's on its row, so
    // an add-on can be standalone on one platform and not another (#1391).
    it("reads each row's isStandalone from its platform game's own content type, else its game's (#1391)", async () => {
      db.gameExpansion.findMany.mockResolvedValue([
        { ...LINK, baseGame: { platformGames: [{ platformId: 'plat-1' }, { platformId: 'plat-pc' }] } },
      ] as never);
      db.gameCollection.findMany.mockResolvedValue([
        { ...entry({ id: 'gc-1' }), platformGame: inView('pg-tabletop', 'g-1', 'plat-1') } as GameCollection,
        {
          ...entry({ id: 'gc-2' }),
          platformGame: inView('pg-pc', 'g-1', 'plat-pc', ContentType.DLC),
        } as GameCollection,
      ]);

      const page = await service.listOwn(paginationQuery({ limit: 20 }));

      expect(page.rows.map((row) => row.platformGame.game.baseGames)).toEqual([
        [{ gameId: 'b-1', isStandalone: true }],
        [{ gameId: 'b-1', isStandalone: false }],
      ]);
    });

    it('reads a game held twice on one page once, and gives both rows its base games', async () => {
      db.gameCollection.findMany.mockResolvedValue([
        entryOn('g-1', { id: 'gc-1', medium: GameMedium.Physical }),
        entryOn('g-1', { id: 'gc-2', medium: GameMedium.Digital }),
      ]);

      const page = await service.listForUser('user-2', paginationQuery({ limit: 20 }));

      expect(db.gameExpansion.findMany).toHaveBeenCalledTimes(1);
      expect(db.gameExpansion.findMany.mock.calls[0][0]?.where).toMatchObject({ expansionGameId: { in: ['g-1'] } });
      expect(page.rows.map((returned) => returned.platformGame.game.baseGames)).toEqual([
        [{ gameId: 'b-1', isStandalone: true }],
        [{ gameId: 'b-1', isStandalone: true }],
      ]);
    });

    it('gives a game with no visible link baseGames: [], never an absent key', async () => {
      db.gameCollection.findMany.mockResolvedValue([entryOn('g-1', { id: 'gc-1' }), entryOn('g-2', { id: 'gc-2' })]);

      const page = await service.listOwn(paginationQuery({ limit: 20 }));

      expect(db.gameExpansion.findMany.mock.calls[0][0]?.where).toMatchObject({
        expansionGameId: { in: ['g-1', 'g-2'] },
      });
      expect(page.rows[1]?.platformGame.game).toHaveProperty('baseGames', []);
    });

    it('issues no link read for an empty page', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);
      db.gameCollection.count.mockResolvedValue(0);

      await service.listOwn(paginationQuery({ limit: 20 }));

      expect(db.gameExpansion.findMany).not.toHaveBeenCalled();
    });

    it.each(Object.keys(singleRowReads) as (keyof typeof singleRowReads)[])(
      '%s returns the row with its base games',
      async (method) => {
        const returned = await singleRowReads[method]();

        expect(db.gameExpansion.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { expansionGameId: { in: ['g-1'] }, baseGame: { is: LIVE_GAMES_THE_VIEWER_COULD_OPEN } },
          }),
        );
        expect(returned.platformGame.game.baseGames).toEqual([{ gameId: 'b-1', isStandalone: true }]);
      },
    );

    // The writes map a missing row (P2025) to 404. The link read runs after
    // the write, outside that mapping, so a failure there reaches the client
    // as itself. A P2025 is the one error the mapping would rewrite, so it is
    // what tells the two placements apart.
    it.each(['addToCollection', 'update', 'remove'] as const)(
      '%s lets a failed link read through as itself, not as a 404',
      async (method) => {
        const failure = dependentRecordNotFound();
        db.gameExpansion.findMany.mockRejectedValue(failure);

        await expect(singleRowReads[method]()).rejects.toBe(failure);
      },
    );
  });
});
