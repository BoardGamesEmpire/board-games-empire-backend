import type { GameCollection, GameRelease, PlatformGame } from '@bge/database';
import {
  Action,
  ContentType,
  DatePrecision,
  GameCondition,
  GameMedium,
  GameRemovalReason,
  ListKind,
  Prisma,
  Reach,
  ResourceType,
} from '@bge/database';
import { foreignKeyViolation, uniqueViolation, uniqueViolationWithoutMeta } from '@bge/database/testing';
import type { CollectionSupplyChange } from '@bge/event';
import { emitCollectionSupplyChanges, syncCollectionEntrySupply } from '@bge/event';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, paginationQuery, rawQueryText, unwrapTransaction } from '@bge/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CopyRevisionSource } from './collection-revisions';
import { COPY_REVISION_SELECT, copyRevisionValues } from './collection-revisions';
import { COLLECTION_INCLUDE, OWNER_COPY_SELECT } from './collection-row';
import { CollectionWriteService } from './collection-write.service';
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

/** What a second insert of one entry identity raises, once the first has committed (#1231). */
const identityViolation = () => uniqueViolation({ index: 'game_collections_user_id_platform_game_id_medium_key' });

/** What an add's insert raises when the platform game it names went before it committed (#1231). */
const platformGameGone = () => foreignKeyViolation({ index: 'game_collections_platform_game_id_fkey' });

/** What a copy's insert raises when the release it names went first: its trigger names itself (#1231). */
const releaseGone = () => foreignKeyViolation({ index: 'collection_copies_release_match' });

/** A copy with nothing known about it: what an add with no `copy` records (#1231). */
const UNKNOWN_COPY = {
  acquiredFrom: null,
  acquiredOn: null,
  acquiredOnPrecision: null,
  condition: null,
  currentValueAmount: null,
  currentValueCurrency: null,
  note: null,
  pricePaidAmount: null,
  pricePaidCurrency: null,
  releaseId: null,
};

const COND = { id: 'sentinel-condition' };
const ME = 'user-1';

const entry = (overrides: Partial<GameCollection> = {}): GameCollection =>
  ({
    id: 'gc-1',
    userId: ME,
    platformGameId: 'pg-1',
    medium: GameMedium.Physical,
    // The include counts the entry's owned copies, which the row sends as
    // its `quantity` (#1231).
    _count: { copies: 1 },
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

/** An entry as the collection include returns it, with `owned` copies neither removed nor taken back (#1231). */
const entryOwning = (owned: number, overrides: Partial<GameCollection> = {}): GameCollection =>
  ({ ...entry(overrides), _count: { copies: owned } }) as GameCollection;

/** The refusal for a collection entry the actor can't see, whatever the reason (#634). */
const ENTRY_NOT_FOUND = {
  status: 404,
  code: 'COLLECTION_ENTRY_NOT_FOUND',
  response: { statusCode: 404, error: 'Not Found', code: 'COLLECTION_ENTRY_NOT_FOUND' },
};

/** A copy's revision columns, as the entry removal reads them: nothing known (#1231). */
const revisionColumns = (id: string): CopyRevisionSource => ({
  id,
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
});

describe('GameCollectionService', () => {
  let service: GameCollectionService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<
      AbilityService,
      'assertCurrentActorCan' | 'getCurrentResourceConditions' | 'getActingUserId' | 'getCurrentAccess'
    >
  >;
  let compose: jest.SpyInstance;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    abilityService = {
      // Allows, unless a spec says otherwise (#1288).
      assertCurrentActorCan: jest.fn(),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue(ME),
      // The actor can read lists, unless a spec says otherwise (#1241).
      getCurrentAccess: jest.fn().mockReturnValue({ [ResourceType.List]: { [Action.read]: 'some' } }),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        GameCollectionService,
        // The REAL write runner, over the mocked database, so the writes
        // below reconcile ownership and sync offers as they do in the api
        // (#1231).
        CollectionWriteService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the lists actually run.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    });

    db = ctx.db;
    // The writes and the reads each run in a callback transaction, which the
    // mock runs against itself (#1221, #1231).
    unwrapTransaction(db);
    syncSupply.mockResolvedValue([]);
    // Each read that returns rows also reads their base-game links (#1070).
    db.gameExpansion.findMany.mockResolvedValue([]);
    // The actor's wishlist is readable, unless a spec says otherwise (#1241).
    db.list.findFirst.mockResolvedValue({ id: 'wishlist-1' } as never);
    db.listEntry.findMany.mockResolvedValue([]);
    // An entry's removal reads its owned copies' acquisitions (#1231).
    db.collectionCopy.findMany.mockResolvedValue([]);
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

  /** The options the first transaction was opened with, its isolation level among them (#1231). */
  function firstTransactionOptions(): unknown {
    return (db.$transaction.mock.calls[0] as unknown[] | undefined)?.[1];
  }

  /**
   * Records in `order`, beside the callback transaction's `begin` and
   * `commit`, each read a collection row is composed from, so a test can pin
   * that they all run inside the one transaction (#1231). Each read keeps the
   * stub it had.
   */
  function recordRowReads(order: string[]): void {
    recordTransaction(order);
    const reads = [
      ['row', db.gameCollection.findUnique],
      ['rows', db.gameCollection.findMany],
      ['count', db.gameCollection.count],
      ['base games', db.gameExpansion.findMany],
      ['owner copies', db.collectionCopy.findMany],
    ] as const;

    for (const [name, mock] of reads) {
      const read = mock as unknown as jest.Mock;
      const stubbed = read.getMockImplementation();
      read.mockImplementation(async (...args: unknown[]) => {
        order.push(name);
        return stubbed?.(...args);
      });
    }
  }

  /**
   * The entry as the write runner reads it after a write: `state` for the
   * reconcile, which selects the entry's removal and its count of owned
   * copies, and for the update, which selects its current rating, and `row`
   * for the answer, which includes the row's relations (#1231).
   */
  function entryReads(
    state: { deletedAt: Date | null; owned: number; rating?: number | null },
    row: GameCollection = entryOwning(state.owned, { deletedAt: state.deletedAt }),
  ): void {
    db.gameCollection.findUniqueOrThrow.mockImplementation((async (args: { include?: unknown }) =>
      args.include === undefined
        ? { deletedAt: state.deletedAt, rating: state.rating ?? null, _count: { copies: state.owned } }
        : row) as never);
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
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable.plugin'));
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
    // the transaction mock runs its callback at any isolation level — so the
    // guarantee has to be pinned or it can regress silently.
    it('reads the rows and the count in one REPEATABLE READ transaction', async () => {
      const order: string[] = [];
      db.gameCollection.findMany.mockResolvedValue([]);
      db.gameCollection.count.mockResolvedValue(0);
      recordRowReads(order);

      await service.listOwn(paginationQuery({ limit: 20 }));

      expect(order).toEqual(['begin', 'rows', 'count', 'commit']);
      expect(firstTransactionOptions()).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
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
      // as an expansion, and those links' base games and their platform games
      // (#1391), and each owned copy's release (#1231). Written out rather
      // than built from the code under test, so a dropped arm fails here.
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
          // Each owned copy's release is embedded, and a re-import renames it
          // in place without touching the entry (#1231).
          { copies: { some: { removedAt: null, retractedAt: null, release: { is: { updatedAt: { gte: since } } } } } },
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
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable.plugin'));
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
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable.plugin'));
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

    // The entry no longer stores a quantity: the include counts its copies
    // neither removed nor taken back, and the row sends that count as
    // `quantity`, without the count's own shape. The release went to the
    // copies with it (#1231).
    it("a row's quantity is its number of owned copies (#1231)", async () => {
      db.gameCollection.findUnique.mockResolvedValue(entryOwning(2));

      const row = await service.getById('gc-1');

      expect(COLLECTION_INCLUDE._count).toEqual({
        select: { copies: { where: { removedAt: null, retractedAt: null } } },
      });
      expect(COLLECTION_INCLUDE).not.toHaveProperty('release');
      expect(db.gameCollection.findUnique.mock.calls[0][0]?.include).toBe(COLLECTION_INCLUDE);
      expect(row.quantity).toBe(2);
      expect(row).not.toHaveProperty('_count');
    });
  });

  describe('addToCollection', () => {
    /** When the entry was removed, for an entry acquired again (#1231). */
    const REMOVED_AT = new Date('2026-11-01T00:00:00Z');

    /** The identity lock's answer: the entry the user already has for the game, or none (#1221). */
    const lockedAs = (row?: { deletedAt: Date | null; id: string; rating?: number | null }) =>
      db.$queryRaw.mockResolvedValue((row === undefined ? [] : [row]) as never);

    beforeEach(() => {
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1' } as PlatformGame);
      lockedAs();
      db.gameCollection.create.mockResolvedValue({ id: 'gc-1' } as GameCollection);
      db.gameCollection.update.mockResolvedValue({ id: 'gc-1' } as GameCollection);
      db.collectionCopy.count.mockResolvedValue(1);
      entryReads({ deletedAt: null, owned: 1 });
    });

    it('answers PLATFORM_GAME_NOT_FOUND when the platform game does not exist (#1231)', async () => {
      db.platformGame.findUnique.mockResolvedValue(null);

      await expect(
        service.addToCollection({ platformGameId: 'pg-404', medium: GameMedium.Physical }),
      ).rejects.toMatchObject({ status: 404, code: 'PLATFORM_GAME_NOT_FOUND' });
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    // The identity lock is the transaction's first lock, so an add takes
    // turns with a nomination naming the entry, or its attendee coming back
    // (#1221).
    it('locks the (user, platformGame, medium) identity FOR UPDATE first', async () => {
      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      const [lock] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
      expect(rawQueryText(lock)).toBe(
        'SELECT id, deleted_at AS "deletedAt", rating FROM game_collections WHERE user_id = ? AND platform_game_id = ? AND medium = ?::game_mediums FOR UPDATE',
      );
      expect(lock.values).toEqual([ME, 'pg-1', GameMedium.Physical]);
    });

    // A create grant pinned to one entry names a row that already exists, so
    // the check of the new row refuses it, as `ListService.create` does
    // (#1288).
    it('a new entry is checked against create with its user, platform game and medium (#1288)', async () => {
      const order: string[] = [];
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        order.push('check');
      });
      db.gameCollection.create.mockImplementation((async () => {
        order.push('insert');
        return { id: 'gc-1' };
      }) as never);

      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.GameCollection, {
        userId: ME,
        platformGameId: 'pg-1',
        medium: GameMedium.Physical,
      });
      expect(order).toEqual(['check', 'insert']);
    });

    it('a new entry the actor may not create is refused, and nothing is written (#1288)', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical })).rejects.toThrow(
        ForbiddenException,
      );
      expect(db.gameCollection.create).not.toHaveBeenCalled();
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
    });

    // The copy fields the request carries describe the new entry's one copy,
    // created with the entry (#1231).
    it('a new entry is created with one copy from `copy` (#1231)', async () => {
      const row = await service.addToCollection({
        platformGameId: 'pg-1',
        medium: GameMedium.Physical,
        rating: 7,
        copy: { acquiredOn: '2019', pricePaid: { amount: 2500, currency: 'EUR' } },
      });

      expect(db.gameCollection.create).toHaveBeenCalledWith({
        data: {
          userId: ME,
          platformGameId: 'pg-1',
          medium: GameMedium.Physical,
          rating: 7,
          lastUpdated: expect.any(Date),
          copies: {
            create: {
              ...UNKNOWN_COPY,
              acquiredOn: new Date('2019-01-01T00:00:00Z'),
              acquiredOnPrecision: DatePrecision.Year,
              pricePaidAmount: 2500,
              pricePaidCurrency: 'EUR',
            },
          },
        },
        select: { id: true },
      });
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
      expect(row.quantity).toBe(1);
    });

    it('a new entry with no `copy` gets one copy with nothing known about it (#1231)', async () => {
      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      expect(db.gameCollection.create.mock.calls[0]?.[0]?.data.copies).toEqual({ create: UNKNOWN_COPY });
    });

    // The add writes a row that exists, so it is an update of that row, held
    // to the update conditions as PATCH is. A grant pinned to another entry
    // is refused before the write; the conditions in the write's `where`
    // hold it to them as well (#1288).
    it('an existing entry is written under its update conditions (#1288)', async () => {
      lockedAs({ id: 'gc-1', deletedAt: null });

      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, favorite: true });

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.update, ResourceType.GameCollection, {
        id: 'gc-1',
        userId: ME,
        platformGameId: 'pg-1',
        medium: GameMedium.Physical,
        deletedAt: null,
      });
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.update,
      );
      expect(db.gameCollection.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'gc-1', AND: [COND] },
        data: { favorite: true, lastUpdated: expect.any(Date) },
        select: { id: true },
      });
      expect(db.gameCollection.create).not.toHaveBeenCalled();
    });

    it('an existing entry outside the update conditions answers COLLECTION_ENTRY_NOT_FOUND (#1288)', async () => {
      lockedAs({ id: 'gc-1', deletedAt: REMOVED_AT });
      db.gameCollection.update.mockRejectedValueOnce(dependentRecordNotFound());

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical }),
      ).rejects.toMatchObject(ENTRY_NOT_FOUND);
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
      expect(syncSupply).not.toHaveBeenCalled();
    });

    it('an existing entry the actor may not update is refused, and nothing is written (#1288)', async () => {
      lockedAs({ id: 'gc-1', deletedAt: REMOVED_AT });
      abilityService.assertCurrentActorCan.mockImplementation((action) => {
        if (action === Action.update) {
          throw new ForbiddenException();
        }
      });

      await expect(service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical })).rejects.toThrow(
        ForbiddenException,
      );
      expect(db.gameCollection.update).not.toHaveBeenCalled();
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
    });

    // Acquiring a removed entry again is an update of it and one new copy,
    // under the entry's lock. The reconcile then clears the entry's removal,
    // and the sync resumes the offers its removal paused, in the same
    // transaction; the emit waits for the commit (#1221, #1231).
    it('a removed entry acquired again gets one new copy from `copy` and resumes its offers (#1221, #1231)', async () => {
      const order: string[] = [];
      recordTransaction(order);
      db.$queryRaw.mockImplementation((async () => {
        order.push('lock');
        return [{ id: 'gc-1', deletedAt: REMOVED_AT }];
      }) as never);
      // The entry's own update, then the reconcile's.
      db.gameCollection.update.mockImplementation((async () => {
        order.push('update');
        return { id: 'gc-1' };
      }) as never);
      db.collectionCopy.count.mockImplementation((async () => {
        order.push('cap');
        return 1;
      }) as never);
      db.collectionCopy.create.mockImplementation((async () => {
        order.push('copy');
        return {};
      }) as never);
      syncSupply.mockImplementation(async () => {
        order.push('sync');
        return SUPPLY_CHANGES;
      });
      emitSupply.mockImplementation(() => {
        order.push('emit');
      });
      entryReads({ deletedAt: REMOVED_AT, owned: 1 });

      const row = await service.addToCollection({
        platformGameId: 'pg-1',
        medium: GameMedium.Physical,
        copy: { condition: GameCondition.LikeNew, acquiredFrom: 'A friend' },
      });

      expect(db.collectionCopy.create).toHaveBeenCalledWith({
        data: { entryId: 'gc-1', ...UNKNOWN_COPY, condition: GameCondition.LikeNew, acquiredFrom: 'A friend' },
        select: OWNER_COPY_SELECT,
      });
      const lastUpdated = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: null }, lastUpdated);
      expect(emitSupply).toHaveBeenCalledWith(eventEmitter, SUPPLY_CHANGES, ME, lastUpdated);
      expect(order).toEqual(['begin', 'lock', 'update', 'cap', 'copy', 'update', 'sync', 'commit', 'emit']);
      expect(row.quantity).toBe(1);
      // The default isolation, READ COMMITTED (#1221).
      expect(db.$transaction.mock.calls[0]).toHaveLength(1);
    });

    // The entry's removal clears in the reconcile, so the add's own update
    // writes only what the request names: play history and every field the
    // request leaves out survive the removal and the acquisition.
    it('a removed entry acquired again keeps its play history and the fields the add leaves out', async () => {
      lockedAs({ id: 'gc-1', deletedAt: REMOVED_AT });

      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, rating: 6 });

      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({ rating: 6, lastUpdated: expect.any(Date) });
    });

    // A replayed add of a game the user owns updates the entry's own fields
    // and adds no copy, whatever `copy` says, so a replay is harmless. The
    // copy is never read, so its release isn't looked up either (#1231).
    it('a repeated add of an owned entry adds no copy (#1231)', async () => {
      lockedAs({ id: 'gc-1', deletedAt: null });

      const row = await service.addToCollection({
        platformGameId: 'pg-1',
        medium: GameMedium.Physical,
        favorite: true,
        copy: { releaseId: 'rel-1', acquiredOn: '2019', pricePaid: { amount: 2500, currency: 'EUR' } },
      });

      expect(db.collectionCopy.create).not.toHaveBeenCalled();
      expect(db.collectionCopy.count).not.toHaveBeenCalled();
      expect(db.gameRelease.findUnique).not.toHaveBeenCalled();
      expect(db.gameCollection.update.mock.calls[0]?.[0]?.data).toEqual({
        favorite: true,
        lastUpdated: expect.any(Date),
      });
      expect(syncSupply).not.toHaveBeenCalled();
      expect(row.quantity).toBe(1);
    });

    describe('rating changes (#1231)', () => {
      const TODAY = new Date('2026-11-26T00:00:00Z');

      beforeEach(() => {
        jest.useFakeTimers({ now: new Date('2026-11-26T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      /** The one change the add appended, dated today (#1231). */
      const change = (rating: number | null) => ({
        data: { entryId: 'gc-1', occurredOn: TODAY, occurredOnPrecision: DatePrecision.Day, rating },
        select: { id: true },
      });

      it('a new entry with a rating appends its first change', async () => {
        await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, rating: 7 });

        expect(db.collectionRatingChange.create).toHaveBeenCalledTimes(1);
        expect(db.collectionRatingChange.create).toHaveBeenCalledWith(change(7));
      });

      // `rating: null` passes validation, which skips null on an optional
      // field, and `pickDefined` keeps it (#1231).
      it('a new entry sent with a null rating appends nothing (#1231)', async () => {
        await service.addToCollection({
          platformGameId: 'pg-1',
          medium: GameMedium.Physical,
          rating: null as unknown as number,
        });

        expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
      });

      it('a new entry with no rating appends nothing', async () => {
        await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

        expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
      });

      it('an add that changes the rating of an existing entry appends a change, after its write', async () => {
        lockedAs({ id: 'gc-1', deletedAt: null, rating: 5 });

        await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, rating: 8 });

        expect(db.collectionRatingChange.create).toHaveBeenCalledTimes(1);
        expect(db.collectionRatingChange.create).toHaveBeenCalledWith(change(8));
        expect(db.gameCollection.update.mock.invocationCallOrder[0]).toBeLessThan(
          db.collectionRatingChange.create.mock.invocationCallOrder[0] ?? 0,
        );
      });

      // A replayed add repeats the rating it already carries (#1231).
      it('a replayed add that sends the rating the entry holds appends nothing', async () => {
        lockedAs({ id: 'gc-1', deletedAt: null, rating: 8 });

        await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, rating: 8 });

        expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
      });

      it('an add that sends no rating appends nothing, whatever the entry holds', async () => {
        lockedAs({ id: 'gc-1', deletedAt: null, rating: 8 });

        await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, favorite: true });

        expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
      });

      it('an entry the actor may not write gets no change', async () => {
        lockedAs({ id: 'gc-1', deletedAt: null, rating: 5 });
        db.gameCollection.update.mockRejectedValueOnce(dependentRecordNotFound());

        await expect(
          service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, rating: 8 }),
        ).rejects.toMatchObject(ENTRY_NOT_FOUND);
        expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
      });
    });

    // The copy cap counts only the copies the user owns (#1231): each
    // removal and acquisition again adds a copy, and no route deletes one, so
    // counting removed copies would one day refuse the game for good.
    it('a removed entry is acquired again whatever copies it has removed, as the cap counts owned copies only', async () => {
      lockedAs({ id: 'gc-1', deletedAt: REMOVED_AT });
      db.collectionCopy.count.mockResolvedValue(0);

      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      expect(db.collectionCopy.count).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
      });
      expect(db.collectionCopy.create).toHaveBeenCalledTimes(1);
    });

    // Two first adds of one game both find no row to lock, and both insert.
    // The second insert waits for the first to commit, then fails on the
    // entry's unique identity. Postgres has aborted its transaction, so the
    // whole transaction runs again, and finds the entry the other made
    // (#1231).
    it('a unique violation on create retries once as an existing entry', async () => {
      db.$queryRaw.mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ id: 'gc-1', deletedAt: null }] as never);
      db.gameCollection.create.mockRejectedValueOnce(identityViolation());

      const row = await service.addToCollection({
        platformGameId: 'pg-1',
        medium: GameMedium.Physical,
        favorite: true,
      });

      expect(db.$transaction).toHaveBeenCalledTimes(2);
      expect(db.gameCollection.create).toHaveBeenCalledTimes(1);
      expect(db.gameCollection.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { id: 'gc-1', AND: [COND] },
          data: expect.objectContaining({ favorite: true }),
        }),
      );
      expect(db.collectionCopy.create).not.toHaveBeenCalled();
      expect(row.id).toBe('gc-1');
    });

    it('retries a unique violation only once', async () => {
      const violation = identityViolation();
      db.gameCollection.create.mockRejectedValue(violation);

      await expect(service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical })).rejects.toBe(
        violation,
      );
      expect(db.$transaction).toHaveBeenCalledTimes(2);
    });

    // Only the race on the entry's identity has an entry to find on a second
    // run. Any other unique the add hits would hit it again (#1231).
    it('a unique violation on another constraint is not retried (#1231)', async () => {
      const violation = uniqueViolation({ index: 'collection_copies_upstream_account_id_upstream_key_key' });
      db.gameCollection.create.mockRejectedValue(violation);

      await expect(service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical })).rejects.toBe(
        violation,
      );
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    // A violation whose constraint can't be named is most likely the
    // identity race, the entry table's only unique besides its generated
    // key; one more run costs a transaction, and a second violation is
    // thrown as it is (#1231).
    it('a unique violation whose constraint cannot be named is retried once (#1231)', async () => {
      db.gameCollection.create.mockRejectedValue(uniqueViolationWithoutMeta());

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(db.$transaction).toHaveBeenCalledTimes(2);
    });

    // The platform game is read without a lock, so it can go before the
    // insert commits; the insert then fails on its foreign key, and the
    // client hears the 404 it would have heard a moment earlier (#1231).
    it('a platform game deleted mid-add answers PLATFORM_GAME_NOT_FOUND, not a 500 (#1231)', async () => {
      db.gameCollection.create.mockRejectedValue(platformGameGone());

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical }),
      ).rejects.toMatchObject({ status: 404, code: 'PLATFORM_GAME_NOT_FOUND' });
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    // A failure that names no constraint keeps the answer the insert gave
    // before it could tell the two apart (#1231).
    it('a foreign key failure naming no constraint answers PLATFORM_GAME_NOT_FOUND (#1231)', async () => {
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameRelease);
      db.gameCollection.create.mockRejectedValue(foreignKeyViolation({ omitConstraint: true }));

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, copy: { releaseId: 'rel-1' } }),
      ).rejects.toMatchObject({ status: 404, code: 'PLATFORM_GAME_NOT_FOUND' });
    });

    // The copy's release is read without a lock too. Gone before the insert,
    // its trigger fails the copy, which is told apart from a platform game
    // gone (#1231).
    it("a new entry's release deleted mid-add answers GAME_RELEASE_NOT_FOUND (#1231)", async () => {
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameRelease);
      db.gameCollection.create.mockRejectedValue(releaseGone());

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, copy: { releaseId: 'rel-1' } }),
      ).rejects.toMatchObject({ status: 404, code: 'GAME_RELEASE_NOT_FOUND' });
    });

    it("a removed entry's new copy whose release went mid-add answers GAME_RELEASE_NOT_FOUND (#1231)", async () => {
      lockedAs({ id: 'gc-1', deletedAt: REMOVED_AT });
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameRelease);
      db.collectionCopy.create.mockRejectedValue(releaseGone());

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, copy: { releaseId: 'rel-1' } }),
      ).rejects.toMatchObject({ status: 404, code: 'GAME_RELEASE_NOT_FOUND' });
    });

    it.each([
      ['missing', null, 'GAME_RELEASE_NOT_FOUND', 404],
      ['of another platform game', { platformGameId: 'pg-2' }, 'COLLECTION_RELEASE_PLATFORM_MISMATCH', 400],
    ])("refuses a new entry's copy whose release is %s with %s (#1231)", async (_, release, code, status) => {
      db.gameRelease.findUnique.mockResolvedValue(release as GameRelease | null);

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, copy: { releaseId: 'rel-1' } }),
      ).rejects.toMatchObject({ status, code });
      expect(db.gameCollection.create).not.toHaveBeenCalled();
    });

    // A new entry and one still owned have no paused offers to resume, so
    // they read no event and emit nothing (#1221).
    it.each([
      ['a new entry', undefined],
      ['a live entry', { id: 'gc-1', deletedAt: null }],
    ])('runs no sync for %s (#1221)', async (_, locked) => {
      lockedAs(locked);

      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      expect(syncSupply).not.toHaveBeenCalled();
      expect(emitSupply).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    /** The entry's row as `lockEntry` answers it (#1231). */
    const LOCKED = { deletedAt: null, medium: GameMedium.Physical, platformGameId: 'pg-1', userId: ME };
    const TODAY = new Date('2026-11-26T00:00:00Z');

    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-11-26T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      db.$queryRaw.mockResolvedValue([LOCKED] as never);
      db.gameCollection.update.mockResolvedValue({ id: 'gc-1' } as GameCollection);
      entryReads({ deletedAt: null, owned: 1, rating: 5 });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('rejects an empty patch', async () => {
      await expect(service.update('gc-1', {})).rejects.toThrow(BadRequestException);
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.gameCollection.update).not.toHaveBeenCalled();
    });

    // The entry is read under the update conditions before it is locked, so
    // a patch of another user's entry never makes its owner's writes wait
    // (#1231).
    it('answers COLLECTION_ENTRY_NOT_FOUND for an entry outside the update conditions, and locks nothing', async () => {
      db.gameCollection.findFirst.mockResolvedValue(null);

      await expect(service.update('gc-1', { favorite: true })).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
      expect(db.gameCollection.findFirst).toHaveBeenCalledWith({
        where: { id: 'gc-1', AND: [COND] },
        select: { id: true },
      });
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.gameCollection.update).not.toHaveBeenCalled();
    });

    // The rating is compared with the entry's current one under the entry's
    // lock, so two patches can't both see the old rating and append twice. It
    // changes no ownership, so it runs in a plain transaction: no reconcile,
    // no supply sync, no emit (#1231, #1221).
    it('locks the entry first, then writes under the update conditions, in one transaction', async () => {
      const order: string[] = [];
      recordTransaction(order);
      db.$queryRaw.mockImplementation((async () => {
        order.push('lock');
        return [LOCKED];
      }) as never);
      db.gameCollection.update.mockImplementation((async () => {
        order.push('update');
        return { id: 'gc-1' };
      }) as never);

      await service.update('gc-1', { favorite: true });

      const [lock] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
      expect(rawQueryText(lock)).toMatch(/FROM game_collections WHERE id = \? FOR UPDATE$/);
      expect(lock.values).toEqual(['gc-1']);
      expect(db.gameCollection.update).toHaveBeenCalledWith({
        where: { id: 'gc-1', AND: [COND] },
        data: { favorite: true, lastUpdated: expect.any(Date) },
        select: { id: true },
      });
      expect(order).toEqual(['begin', 'lock', 'update', 'commit']);
      expect(syncSupply).not.toHaveBeenCalled();
      expect(emitSupply).not.toHaveBeenCalled();
    });

    it('answers the entry as the transaction leaves it', async () => {
      const row = await service.update('gc-1', { favorite: true });

      expect(row).toMatchObject({ id: 'gc-1', quantity: 1 });
      expect(db.gameCollection.findUniqueOrThrow).toHaveBeenLastCalledWith({
        where: { id: 'gc-1' },
        include: COLLECTION_INCLUDE,
      });
    });

    it('404s when the entry does not exist (or is not the actor’s), naming the collection entry (#634)', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.update('gc-404', { rating: 7 })).rejects.toMatchObject(ENTRY_NOT_FOUND);
      expect(db.gameCollection.update).not.toHaveBeenCalled();
      expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
    });

    it('404s an entry outside the update conditions, and appends no change (#634, #1288)', async () => {
      db.gameCollection.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.update('gc-1', { rating: 7 })).rejects.toMatchObject(ENTRY_NOT_FOUND);
      expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
    });

    it('passes explicit nulls through to clear nullable fields', async () => {
      await service.update('gc-1', { rating: null, comment: null, favorite: true });

      expect(db.gameCollection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'gc-1', AND: [COND] }),
          data: expect.objectContaining({ rating: null, comment: null, favorite: true }),
        }),
      );
    });

    it('omits fields the caller did not send', async () => {
      await service.update('gc-1', { favorite: true });

      const { data } = db.gameCollection.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('rating');
      expect(data).not.toHaveProperty('comment');
      expect(data).not.toHaveProperty('playAgain');
    });

    it('uses update conditions, not read conditions, for the write', async () => {
      await service.update('gc-1', { rating: 7 });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.update,
      );
    });

    describe('rating changes (#1231)', () => {
      it('a PATCH that changes the rating appends a change dated today', async () => {
        await service.update('gc-1', { rating: 8 });

        expect(db.collectionRatingChange.create).toHaveBeenCalledTimes(1);
        expect(db.collectionRatingChange.create).toHaveBeenCalledWith({
          data: { entryId: 'gc-1', occurredOn: TODAY, occurredOnPrecision: DatePrecision.Day, rating: 8 },
          select: { id: true },
        });
        expect(db.gameCollection.findUniqueOrThrow).toHaveBeenCalledWith({
          where: { id: 'gc-1' },
          select: { rating: true },
        });
      });

      it('a PATCH that sends the same rating appends nothing', async () => {
        await service.update('gc-1', { rating: 5, favorite: true });

        expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
      });

      it('clearing the rating appends a change with no value', async () => {
        await service.update('gc-1', { rating: null });

        expect(db.collectionRatingChange.create).toHaveBeenCalledWith({
          data: { entryId: 'gc-1', occurredOn: TODAY, occurredOnPrecision: DatePrecision.Day, rating: null },
          select: { id: true },
        });
      });

      it('clearing a rating that was never set appends nothing', async () => {
        entryReads({ deletedAt: null, owned: 1, rating: null });

        await service.update('gc-1', { rating: null });

        expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
      });

      it('a PATCH that sends no rating reads none and appends nothing', async () => {
        await service.update('gc-1', { comment: 'Great' });

        expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
        expect(db.gameCollection.findUniqueOrThrow).not.toHaveBeenCalledWith(
          expect.objectContaining({ select: { rating: true } }),
        );
      });

      // The entry's own write goes first, under its conditions, so a refused
      // one keeps no change (#1288).
      it('appends the change after the entry write', async () => {
        await service.update('gc-1', { rating: 8 });

        expect(db.gameCollection.update.mock.invocationCallOrder[0]).toBeLessThan(
          db.collectionRatingChange.create.mock.invocationCallOrder[0] ?? 0,
        );
      });
    });
  });

  describe('remove', () => {
    /** The entry's row as `lockEntry` answers it (#1231). */
    const LOCKED = { deletedAt: null, medium: GameMedium.Physical, platformGameId: 'pg-1', userId: ME };

    beforeEach(() => {
      db.$queryRaw.mockResolvedValue([LOCKED] as never);
      db.gameCollection.update.mockResolvedValue({ id: 'gc-1' } as GameCollection);
      db.collectionCopy.updateMany.mockResolvedValue({ count: 1 });
      // After its copies are removed the entry owns none, so the reconcile
      // removes it (#1231).
      entryReads({ deletedAt: null, owned: 0 }, entryOwning(0, { deletedAt: new Date() }));
    });

    // The entry is read under the delete conditions before it is locked, so
    // a removal of another user's entry never makes its owner's writes wait
    // (#1231).
    it('answers COLLECTION_ENTRY_NOT_FOUND for an entry outside the delete conditions, and locks nothing', async () => {
      db.gameCollection.findFirst.mockResolvedValue(null);

      await expect(service.remove('gc-1', { reason: GameRemovalReason.Sold })).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.delete,
      );
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.collectionCopy.updateMany).not.toHaveBeenCalled();
    });

    // The entry's row is the transaction's first lock, so the removal takes
    // turns with a nomination naming the entry (#1221). It is then held to
    // the delete conditions and to being live, under that lock, so an
    // update-only key can't remove it, and a repeat misses (#1288). The
    // reconcile removes the entry once its last owned copy is removed, and
    // the sync pauses its offers in the same transaction; the emit waits for
    // the commit, so no listener hears of a pause that rolled back.
    it('locks the entry, holds it to its delete conditions, removes its owned copies, then syncs and emits (#1221, #1288)', async () => {
      const order: string[] = [];
      recordTransaction(order);
      db.$queryRaw.mockImplementation((async () => {
        order.push('lock');
        return [LOCKED];
      }) as never);
      // The scoped check, then the reconcile's.
      db.gameCollection.update.mockImplementation((async () => {
        order.push('update');
        return { id: 'gc-1' };
      }) as never);
      db.collectionCopy.updateMany.mockImplementation((async () => {
        order.push('copies');
        return { count: 1 };
      }) as never);
      syncSupply.mockImplementation(async () => {
        order.push('sync');
        return SUPPLY_CHANGES;
      });
      emitSupply.mockImplementation(() => {
        order.push('emit');
      });

      await service.remove('gc-1', { reason: GameRemovalReason.Sold });

      const [lock] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
      expect(rawQueryText(lock)).toMatch(/FROM game_collections WHERE id = \? FOR UPDATE$/);
      expect(lock.values).toEqual(['gc-1']);
      expect(db.gameCollection.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'gc-1', deletedAt: null, AND: [COND] },
        data: { lastUpdated: expect.any(Date) },
        select: { id: true },
      });
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.delete,
      );

      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(syncSupply).toHaveBeenCalledWith(db, { id: 'gc-1', deletedAt: now }, now);
      expect(emitSupply).toHaveBeenCalledWith(eventEmitter, SUPPLY_CHANGES, ME, now);
      expect(order).toEqual(['begin', 'lock', 'update', 'copies', 'update', 'sync', 'commit', 'emit']);
      // Never a hard delete: play history and the rows that name the entry
      // survive a removal.
      expect(db.gameCollection.delete).not.toHaveBeenCalled();
    });

    // A removal edits each copy it removes, so each keeps what it said before
    // as a revision, read under the entry's lock and written before the
    // removal, in one statement (#1231).
    it('an entry removal keeps a revision of each copy it removes, with its values before the removal (#1231)', async () => {
      const owned = [
        {
          ...revisionColumns('copy-1'),
          note: 'First',
          acquiredOn: new Date('2019-01-01T00:00:00Z'),
          acquiredOnPrecision: DatePrecision.Year,
        },
        { ...revisionColumns('copy-2'), pricePaidAmount: 1250, pricePaidCurrency: 'EUR' },
      ];
      db.collectionCopy.findMany.mockResolvedValueOnce(owned as never);
      const order: string[] = [];
      db.collectionCopyRevision.createMany.mockImplementation((async () => {
        order.push('revisions');
        return { count: 2 };
      }) as never);
      db.collectionCopy.updateMany.mockImplementation((async () => {
        order.push('removal');
        return { count: 2 };
      }) as never);

      await service.remove('gc-1', { reason: GameRemovalReason.Sold });

      expect(db.collectionCopyRevision.createMany).toHaveBeenCalledWith({
        data: owned.map((copy) => ({ copyId: copy.id, values: copyRevisionValues(copy) })),
      });
      expect(db.collectionCopyRevision.createMany.mock.calls[0]?.[0]?.data).toEqual([
        {
          copyId: 'copy-1',
          values: expect.objectContaining({ note: 'First', acquiredOn: '2019-01-01', removedAt: null }),
        },
        { copyId: 'copy-2', values: expect.objectContaining({ pricePaidAmount: 1250, removedAt: null }) },
      ]);
      expect(order).toEqual(['revisions', 'removal']);
    });

    it('removal dates every owned copy removedOn when given, with the reason', async () => {
      await service.remove('gc-1', { reason: GameRemovalReason.Sold, removedOn: '2019-03' });

      expect(db.collectionCopy.updateMany).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
        data: {
          removedAt: expect.any(Date),
          removedOn: new Date('2019-03-01T00:00:00Z'),
          removedOnPrecision: DatePrecision.Month,
          removeReason: GameRemovalReason.Sold,
          editedByUserAt: expect.any(Date),
        },
      });
    });

    // A removal is the user's word on the copy, so a later sync must not
    // undo it: each copy it removes is stamped as edited by the user (#1231).
    it('an entry removal stamps each copy it removes as edited by the user (#1231)', async () => {
      await service.remove('gc-1', {});

      expect(db.collectionCopy.updateMany).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
        data: expect.objectContaining({ editedByUserAt: expect.any(Date), removedAt: expect.any(Date) }),
      });

      const { data } = db.collectionCopy.updateMany.mock.calls[0][0];
      expect(data.editedByUserAt).toEqual(data.removedAt);
    });

    it('defaults the reason to null', async () => {
      await service.remove('gc-1', {});

      expect(db.collectionCopy.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ removeReason: null }) }),
      );
    });

    describe('with the clock at 23:30 in New York, already the next day in UTC', () => {
      beforeEach(() => {
        jest.useFakeTimers({ now: new Date('2026-11-26T23:30:00-05:00'), doNotFake: ['nextTick', 'setImmediate'] });
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      // With no date given, the removal is dated today, in UTC: the server's
      // zone never decides what today is (#1231).
      it('removal dates every owned copy today in UTC when no date is given', async () => {
        await service.remove('gc-1', { reason: GameRemovalReason.Sold });

        expect(db.collectionCopy.updateMany.mock.calls[0]?.[0]?.data).toEqual({
          removedAt: new Date('2026-11-27T04:30:00Z'),
          removedOn: new Date('2026-11-27T00:00:00Z'),
          removedOnPrecision: DatePrecision.Day,
          removeReason: GameRemovalReason.Sold,
          editedByUserAt: new Date('2026-11-27T04:30:00Z'),
        });
      });

      // Today in UTC is already the 27th, so the 27th is not in the future
      // and the 28th is (#1231).
      it('removal takes the date of today in UTC', async () => {
        await service.remove('gc-1', { removedOn: '2026-11-27' });

        expect(db.collectionCopy.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
          removedOn: new Date('2026-11-27T00:00:00Z'),
        });
      });

      it('removal refuses a future date with COLLECTION_DATE_IN_FUTURE, and locks nothing', async () => {
        await expect(service.remove('gc-1', { removedOn: '2026-11-28' })).rejects.toMatchObject({
          status: 400,
          code: 'COLLECTION_DATE_IN_FUTURE',
        });
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(db.collectionCopy.updateMany).not.toHaveBeenCalled();
      });
    });

    // A copy may be acquired on a day that is today east of UTC but tomorrow
    // in UTC, so a removal with no date, dated today in UTC, would end before
    // it began. The date is decided per copy (#1231).
    describe('a removal with no date, with the clock at 23:30 UTC on 2026-11-26', () => {
      const TODAY = {
        removedOn: new Date('2026-11-26T00:00:00Z'),
        removedOnPrecision: DatePrecision.Day,
      };
      const TOMORROW = {
        removedOn: new Date('2026-11-27T00:00:00Z'),
        removedOnPrecision: DatePrecision.Day,
      };

      beforeEach(() => {
        jest.useFakeTimers({ now: new Date('2026-11-26T23:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('a removal with no date of a copy acquired later than today in UTC is dated its acquisition day (#1231)', async () => {
        db.collectionCopy.findMany.mockResolvedValueOnce([
          {
            ...revisionColumns('copy-1'),
            acquiredOn: new Date('2026-11-27T00:00:00Z'),
            acquiredOnPrecision: DatePrecision.Day,
          },
        ] as never);

        await service.remove('gc-1', {});

        expect(db.collectionCopy.updateMany).toHaveBeenCalledTimes(1);
        expect(db.collectionCopy.updateMany.mock.calls[0]?.[0]?.data).toMatchObject(TOMORROW);
      });

      it.each([
        ['no acquisition date', null, null],
        ['an earlier acquisition', new Date('2026-11-20T00:00:00Z'), DatePrecision.Day],
        ['a Month acquisition that has begun', new Date('2026-11-01T00:00:00Z'), DatePrecision.Month],
        ['a Year acquisition that has begun', new Date('2026-01-01T00:00:00Z'), DatePrecision.Year],
      ])(
        'dates every owned copy today in UTC, as one statement, for %s',
        async (_, acquiredOn, acquiredOnPrecision) => {
          db.collectionCopy.findMany.mockResolvedValueOnce([
            { ...revisionColumns('copy-1'), acquiredOn, acquiredOnPrecision },
            { ...revisionColumns('copy-2'), acquiredOn, acquiredOnPrecision },
          ] as never);

          await service.remove('gc-1', {});

          expect(db.collectionCopy.updateMany).toHaveBeenCalledTimes(1);
          expect(db.collectionCopy.updateMany).toHaveBeenCalledWith({
            where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
            data: expect.objectContaining(TODAY),
          });
        },
      );

      // The copies of one entry can differ: each is dated by its own
      // acquisition, so the one acquired tomorrow is written apart.
      it('dates each copy by its own acquisition, one statement per date', async () => {
        db.collectionCopy.findMany.mockResolvedValueOnce([
          {
            ...revisionColumns('copy-1'),
            acquiredOn: new Date('2026-11-20T00:00:00Z'),
            acquiredOnPrecision: DatePrecision.Day,
          },
          {
            ...revisionColumns('copy-2'),
            acquiredOn: new Date('2026-11-27T00:00:00Z'),
            acquiredOnPrecision: DatePrecision.Day,
          },
          { ...revisionColumns('copy-3'), acquiredOn: null, acquiredOnPrecision: null },
        ] as never);

        await service.remove('gc-1', { reason: GameRemovalReason.Sold });

        expect(db.collectionCopy.updateMany).toHaveBeenCalledTimes(2);
        expect(db.collectionCopy.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['copy-1', 'copy-3'] }, entryId: 'gc-1', removedAt: null, retractedAt: null },
          data: expect.objectContaining({ ...TODAY, removeReason: GameRemovalReason.Sold }),
        });
        expect(db.collectionCopy.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['copy-2'] }, entryId: 'gc-1', removedAt: null, retractedAt: null },
          data: expect.objectContaining({ ...TOMORROW, removeReason: GameRemovalReason.Sold }),
        });
      });

      it('still refuses a removal date the user sent that ends before an acquisition', async () => {
        db.collectionCopy.findMany.mockResolvedValueOnce([
          {
            ...revisionColumns('copy-1'),
            acquiredOn: new Date('2026-11-27T00:00:00Z'),
            acquiredOnPrecision: DatePrecision.Day,
          },
        ] as never);

        await expect(service.remove('gc-1', { removedOn: '2026-11-26' })).rejects.toMatchObject({
          code: 'COLLECTION_DATE_ORDER',
        });
        expect(db.collectionCopy.updateMany).not.toHaveBeenCalled();
      });
    });

    // A copy can't be removed before it was acquired. Each owned copy is
    // checked against the removal's date, under the entry's lock (#1231).
    it('refuses a removal dated before an owned copy was acquired with COLLECTION_DATE_ORDER', async () => {
      db.collectionCopy.findMany.mockResolvedValueOnce([
        { ...revisionColumns('copy-1'), acquiredOn: null, acquiredOnPrecision: null },
        {
          ...revisionColumns('copy-2'),
          acquiredOn: new Date('2020-05-01T00:00:00Z'),
          acquiredOnPrecision: DatePrecision.Month,
        },
      ] as never);

      await expect(service.remove('gc-1', { removedOn: '2019' })).rejects.toMatchObject({
        status: 400,
        code: 'COLLECTION_DATE_ORDER',
      });
      expect(db.collectionCopy.findMany).toHaveBeenCalledWith({
        where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
        select: COPY_REVISION_SELECT,
      });
      expect(db.collectionCopyRevision.createMany).not.toHaveBeenCalled();
      expect(db.collectionCopy.updateMany).not.toHaveBeenCalled();
      expect(syncSupply).not.toHaveBeenCalled();
    });

    // The last day of "2020" is after a May 2020 acquisition (#1231).
    it('takes a removal whose period ends on or after the acquisition', async () => {
      db.collectionCopy.findMany.mockResolvedValueOnce([
        {
          ...revisionColumns('copy-1'),
          acquiredOn: new Date('2020-05-01T00:00:00Z'),
          acquiredOnPrecision: DatePrecision.Month,
        },
      ] as never);

      await service.remove('gc-1', { removedOn: '2020' });

      expect(db.collectionCopy.updateMany).toHaveBeenCalled();
    });

    // The answer is the entry as the transaction leaves it: removed, owning
    // no copy, whatever the sync changed (#1221, #1231).
    it('answers the removed entry, which owns no copy', async () => {
      const removed = await service.remove('gc-1', {});

      expect(removed).toMatchObject({ id: 'gc-1', deletedAt: expect.any(Date), quantity: 0 });
      expect(db.gameCollection.findUniqueOrThrow).toHaveBeenLastCalledWith({
        where: { id: 'gc-1' },
        include: COLLECTION_INCLUDE,
      });
    });

    // `now` is taken before the entry lock is waited on, so a copy removal
    // that commits meanwhile can stamp a later `removedAt` than this one's.
    // The entry's removal is this request's, so its reason is the one the
    // request gave, or none when it gave none (#1231).
    it.each([
      ['a reason', GameRemovalReason.Sold, GameRemovalReason.Sold],
      ['no reason', undefined, null],
    ])(
      'an entry removal names its own reason, whatever an earlier-stamped copy says (#1231): %s',
      async (_, reason, deleteReason) => {
        db.collectionCopy.findFirst.mockResolvedValue({ removeReason: GameRemovalReason.Traded } as never);

        await service.remove('gc-1', { reason });

        expect(db.gameCollection.update).toHaveBeenLastCalledWith({
          where: { id: 'gc-1' },
          data: { deletedAt: expect.any(Date), deleteReason, lastUpdated: expect.any(Date) },
          select: { id: true },
        });
      },
    );

    // A client reads this 404 as "already removed" and completes its queued
    // removal, so it must be told apart from a route that moved (#634). No
    // copy is touched and nothing is synced (#1221, #1231).
    it('404s a missing entry, naming the collection entry (#634)', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.remove('gc-404', {})).rejects.toMatchObject(ENTRY_NOT_FOUND);
      expect(db.gameCollection.update).not.toHaveBeenCalled();
      expect(db.collectionCopy.updateMany).not.toHaveBeenCalled();
      expect(syncSupply).not.toHaveBeenCalled();
    });

    it('404s an entry already removed, or outside the delete conditions, alike (#634, #1288)', async () => {
      db.gameCollection.update.mockRejectedValueOnce(dependentRecordNotFound());

      await expect(service.remove('gc-1', {})).rejects.toMatchObject(ENTRY_NOT_FOUND);
      expect(db.collectionCopy.updateMany).not.toHaveBeenCalled();
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
      update: () => service.update('gc-1', { rating: 7 }),
      remove: () => service.remove('gc-1', {}),
    } as const;

    beforeEach(() => {
      db.gameExpansion.findMany.mockResolvedValue([LINK] as never);
      db.gameCollection.count.mockResolvedValue(1);
      db.gameCollection.findUnique.mockResolvedValue(entryOn('g-1'));
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1' } as PlatformGame);
      db.gameCollection.update.mockResolvedValue(entryOn('g-1'));
      // The add and the removal each lock the entry first, and answer the row
      // the write runner reads after them (#1231).
      db.$queryRaw.mockResolvedValue([
        { id: 'gc-1', deletedAt: null, medium: GameMedium.Physical, platformGameId: 'pg-1', userId: ME },
      ] as never);
      entryReads({ deletedAt: null, owned: 1 }, entryOn('g-1'));
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

  /**
   * #1231. A row carries the entry's owned copies. Every reader gets each
   * copy's id, edition and condition, from the include; the entry's owner gets the
   * copy as the copy routes send it, read in a query of its own whose `where`
   * names the acting user as the entry's owner. That bound, not a branch on
   * who is reading, keeps the private fields to the entry's owner.
   */
  describe('copies on collection rows (#1231)', () => {
    const PUBLIC_COPY = { condition: GameCondition.Good, id: 'copy-1', release: null };

    /** `copy-1` as the entry owner's query reads it: every field the copy routes send, and its entry. */
    const ownersCopyRow = (entryId = 'gc-1', id = 'copy-1') => ({
      entryId,
      id,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      condition: GameCondition.Good,
      acquiredOn: new Date('2020-06-01T00:00:00Z'),
      acquiredOnPrecision: DatePrecision.Month,
      acquiredFrom: 'A friend',
      pricePaidAmount: 2500,
      pricePaidCurrency: 'USD',
      currentValueAmount: null,
      currentValueCurrency: null,
      note: 'Sleeved',
      removedAt: null,
      removedOn: null,
      removedOnPrecision: null,
      removeReason: null,
      release: null,
    });

    /** `copy-1` as the entry's owner is sent it. */
    const ownersCopy = (id = 'copy-1') => ({
      id,
      createdAt: new Date('2026-01-02T00:00:00Z'),
      condition: GameCondition.Good,
      acquiredOn: '2020-06',
      acquiredFrom: 'A friend',
      pricePaid: { amount: 2500, currency: 'USD' },
      currentValue: null,
      note: 'Sleeved',
      removedAt: null,
      removedOn: null,
      removeReason: null,
      release: null,
    });

    /** The entry owner's query for `entryIds`, bound to `userId` as their owner. */
    const ownerCopyQuery = (entryIds: string[], userId = ME) => ({
      where: { entryId: { in: entryIds }, entry: { userId }, removedAt: null, retractedAt: null },
      select: { ...OWNER_COPY_SELECT, entryId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    /** An entry as the include returns it, with its owned copies in the public shape. */
    const withPublicCopies = (overrides: Partial<GameCollection> = {}) =>
      ({ ...entry(overrides), copies: [PUBLIC_COPY] }) as GameCollection;

    it('the include selects each owned copy in its public shape alone, oldest first', () => {
      expect(COLLECTION_INCLUDE.copies).toEqual({
        where: { removedAt: null, retractedAt: null },
        select: { condition: true, id: true, release: { select: { editionName: true, id: true, releaseYear: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });

    it("getById sends the entry's owner their own copies, read in a query of its own bound to them", async () => {
      db.gameCollection.findUnique.mockResolvedValue(withPublicCopies());
      db.collectionCopy.findMany.mockResolvedValue([ownersCopyRow()] as never);

      const row = await service.getById('gc-1');

      expect(db.collectionCopy.findMany).toHaveBeenCalledTimes(1);
      expect(db.collectionCopy.findMany).toHaveBeenCalledWith(ownerCopyQuery(['gc-1']));
      expect(row.copies).toEqual([ownersCopy()]);
    });

    // The review's third focus: a friend may read the entry, and the entry
    // owner's query, bound to the friend, finds no copy of it (#1231).
    it("getById of another user's entry keeps the public copies: the query bound to the reader finds none", async () => {
      db.gameCollection.findUnique.mockResolvedValue(withPublicCopies({ userId: 'user-2' }));

      const row = await service.getById('gc-1');

      expect(db.collectionCopy.findMany).toHaveBeenCalledWith(ownerCopyQuery(['gc-1']));
      expect(row.copies).toEqual([PUBLIC_COPY]);
    });

    // A plugin, the system or an external actor has no user behind it, so it
    // owns no entry, and nothing is read for it (#1231).
    it('reads no owner copies for an actor with no user behind it', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });
      db.gameCollection.findUnique.mockResolvedValue(withPublicCopies());

      const row = await service.getById('gc-1');

      expect(db.collectionCopy.findMany).not.toHaveBeenCalled();
      expect(row.copies).toEqual([PUBLIC_COPY]);
    });

    // An API key acts for the user who made it, the entry's owner here, and the
    // key reads the entry only within its own grants. The copy routes already
    // send the key the entry owner's shape, so a row it may read carries the same
    // fields; a reader the key can't be is never the entry's owner (#1231).
    it("sends an API key acting for the entry's owner that owner's copies, bound to them", async () => {
      abilityService.getActingUserId.mockReturnValue('key-owner');
      db.gameCollection.findUnique.mockResolvedValue(withPublicCopies({ userId: 'key-owner' }));
      db.collectionCopy.findMany.mockResolvedValue([ownersCopyRow()] as never);

      const row = await service.getById('gc-1');

      expect(db.collectionCopy.findMany).toHaveBeenCalledWith(ownerCopyQuery(['gc-1'], 'key-owner'));
      expect(row.copies).toEqual([ownersCopy()]);
    });

    it("listOwn reads the page's owner copies in one query, each row getting its own", async () => {
      db.gameCollection.findMany.mockResolvedValue([
        withPublicCopies({ id: 'gc-1' }),
        withPublicCopies({ id: 'gc-2' }),
      ]);
      db.collectionCopy.findMany.mockResolvedValue([
        ownersCopyRow('gc-1', 'copy-1'),
        ownersCopyRow('gc-2', 'copy-2'),
        ownersCopyRow('gc-2', 'copy-3'),
      ] as never);

      const page = await service.listOwn(paginationQuery({ limit: 20 }));

      expect(db.collectionCopy.findMany).toHaveBeenCalledTimes(1);
      expect(db.collectionCopy.findMany).toHaveBeenCalledWith(ownerCopyQuery(['gc-1', 'gc-2']));
      expect(page.rows.map((row) => row.copies)).toEqual([
        [ownersCopy('copy-1')],
        [ownersCopy('copy-2'), ownersCopy('copy-3')],
      ]);
    });

    it('reads no owner copies for an empty page', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);
      db.gameCollection.count.mockResolvedValue(0);

      await service.listOwn(paginationQuery({ limit: 20 }));

      expect(db.collectionCopy.findMany).not.toHaveBeenCalled();
    });

    // Another user's collection is the route other readers read, so its rows
    // are the public shape for every caller, the entry's owner too (#1231).
    it("listForUser never reads owner copies, even of the acting user's own collection", async () => {
      db.gameCollection.findMany.mockResolvedValue([withPublicCopies()]);
      db.collectionCopy.findMany.mockResolvedValue([ownersCopyRow()] as never);

      const page = await service.listForUser(ME, paginationQuery({ limit: 20 }));

      expect(db.collectionCopy.findMany).not.toHaveBeenCalled();
      expect(page.rows[0]?.copies).toEqual([PUBLIC_COPY]);
    });

    // A row's `quantity` is the include's count of owned copies, and the
    // owner's copies are a read of their own. Read apart, a copy write
    // committed between them would answer a `quantity` of 2 beside one copy,
    // so both reads, and the base games beside them, share the row's
    // snapshot (#1231).
    describe('in one state of the entry', () => {
      it('listOwn composes its page inside the REPEATABLE READ transaction that read it', async () => {
        const order: string[] = [];
        db.gameCollection.findMany.mockResolvedValue([withPublicCopies()]);
        db.gameCollection.count.mockResolvedValue(1);
        db.collectionCopy.findMany.mockResolvedValue([ownersCopyRow()] as never);
        recordRowReads(order);

        const page = await service.listOwn(paginationQuery({ limit: 20 }));

        expect(order).toEqual(['begin', 'rows', 'count', 'base games', 'owner copies', 'commit']);
        expect(firstTransactionOptions()).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        });
        expect(page.rows[0]?.copies).toEqual([ownersCopy()]);
      });

      it('getById composes its row inside a REPEATABLE READ transaction that read it', async () => {
        const order: string[] = [];
        db.gameCollection.findUnique.mockResolvedValue(withPublicCopies());
        db.collectionCopy.findMany.mockResolvedValue([ownersCopyRow()] as never);
        recordRowReads(order);

        await service.getById('gc-1');

        expect(order).toEqual(['begin', 'row', 'base games', 'owner copies', 'commit']);
        expect(firstTransactionOptions()).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        });
      });

      it('listForUser composes its page inside the transaction that read it', async () => {
        const order: string[] = [];
        db.gameCollection.findMany.mockResolvedValue([withPublicCopies()]);
        db.gameCollection.count.mockResolvedValue(1);
        recordRowReads(order);

        await service.listForUser(ME, paginationQuery({ limit: 20 }));

        expect(order).toEqual(['begin', 'rows', 'count', 'base games', 'commit']);
      });
    });

    describe("a write's answer", () => {
      beforeEach(() => {
        db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1' } as PlatformGame);
        db.gameCollection.update.mockResolvedValue(withPublicCopies());
        db.$queryRaw.mockResolvedValue([
          { id: 'gc-1', deletedAt: null, medium: GameMedium.Physical, platformGameId: 'pg-1', userId: ME },
        ] as never);
        entryReads({ deletedAt: null, owned: 1 }, withPublicCopies());
      });

      it.each([
        ['addToCollection', () => service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical })],
        ['update', () => service.update('gc-1', { rating: 7 })],
      ] as const)("%s sends the entry's owner their own copies", async (_method, write) => {
        db.collectionCopy.findMany.mockResolvedValue([ownersCopyRow()] as never);

        const row = await write();

        expect(db.collectionCopy.findMany).toHaveBeenLastCalledWith(ownerCopyQuery(['gc-1']));
        expect(row.copies).toEqual([ownersCopy()]);
      });

      // The write's transaction holds the entry's lock, which every copy
      // write takes first, so the answer read before it commits is one state
      // of the entry (#1231).
      it.each([
        ['addToCollection', () => service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical })],
        ['update', () => service.update('gc-1', { rating: 7 })],
        ['remove', () => service.remove('gc-1', {})],
      ] as const)("%s reads its answer's base games and owner copies before it commits", async (_method, write) => {
        const order: string[] = [];
        recordRowReads(order);

        await write();

        expect(order.slice(-3)).toEqual(['base games', 'owner copies', 'commit']);
      });
    });
  });
});
