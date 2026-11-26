import {
  Action,
  constraintIdentity,
  DatabaseService,
  identifiesConstraint,
  isPrismaDependentRecordNotFoundError,
  isPrismaForeignKeyConstraintError,
  ListKind,
  Prisma,
  readBaseGameLinksOnPlatform,
  readWishlistedPlatformGames,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto, pickDefined } from '@bge/shared';
import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { assertCopyRoom, copyCreateData } from './collection-copy-data';
import type { GameCollectionRow, GameCollectionWithRelations } from './collection-row';
import { changedSince, COLLECTION_INCLUDE, OWNED_COPY } from './collection-row';
import { CollectionWriteService } from './collection-write.service';
import {
  CreateGameCollectionDto,
  GameCollectionDto,
  ListGameCollectionsQueryDto,
  ListUserGameCollectionsQueryDto,
  RemoveGameCollectionQueryDto,
  UpdateGameCollectionDto,
} from './dto';
import { collectionEntryNotFound } from './game-collection.errors';
import type { PartialDate } from './values/partial-date';
import {
  assertNotInFuture,
  assertRemovalAfterAcquisition,
  parsePartialDate,
  partialDateFromColumns,
  todayUtc,
} from './values/partial-date';

/**
 * The unique that keeps a user to one entry per platform game and medium, in
 * every spelling a P2002 identity reports it (see `identifiesConstraint`): the
 * index name, the raw columns, and the Prisma fields (#1231).
 */
const ENTRY_IDENTITY_SPELLINGS = [
  ['game_collections_user_id_platform_game_id_medium_key'],
  ['user_id', 'platform_game_id', 'medium'],
  ['userId', 'platformGameId', 'medium'],
] as const;

/**
 * Whether `error` is a unique violation on the entry's identity, the race of
 * two first adds (#1231). One whose constraint can't be named counts: the
 * entry table's only other unique is its generated key, so the identity is by
 * far the likelier, and the retry it earns runs once.
 */
function isEntryIdentityViolation(error: unknown): boolean {
  const identity = constraintIdentity(error);

  return identity.source === 'unknown' || identifiesConstraint(identity, ...ENTRY_IDENTITY_SPELLINGS);
}

/**
 * The date a removal records (#1231): `removedOn` as the user gave it, which
 * the DTO's `@IsPartialDate()` has already passed, or today in UTC when they
 * gave none. A date after today is refused.
 */
function removalDate(removedOn: string | undefined, now: Date): PartialDate {
  const removal = (removedOn === undefined ? null : parsePartialDate(removedOn)) ?? todayUtc(now);
  assertNotInFuture(removal, now);

  return removal;
}

/**
 * Each method that returns collection rows is annotated with the DTO the
 * routes document, and the DTO's nested classes implement the row's types, so
 * a field missing on either side fails the typecheck (#1070).
 */
@Injectable()
export class GameCollectionService {
  private readonly logger = new Logger(GameCollectionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
    private readonly writes: CollectionWriteService,
  ) {}

  /**
   * The acting user's own collection. Tombstoned (previously owned) entries are
   * excluded by default; `includeDeleted` adds them (delta sync), `deletedOnly`
   * is the resurrection view.
   *
   * The scope is the acting user's entries, and the ceiling only clips it
   * (#514). For an `apiKey` actor it carries the key ∩ owner floor. The
   * tombstone, medium, favourite and date filters are caller input, so they
   * sit beside the composed clause rather than inside it.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors:
   * "my collection" has no meaning without a user, and the refusal must never
   * soften into an empty page. PROVISIONAL — #395.
   */
  async listOwn(query: ListGameCollectionsQueryDto): Promise<PaginatedRows<GameCollectionDto>> {
    const { includeDeleted, deletedOnly, medium, favorite, updatedSince } = query;
    const userId = resolveScopeSubjectId(this.abilityService);

    const where = {
      AND: [
        this.scopeComposer.compose(ResourceType.GameCollection, Action.read, { userId }),
        {
          ...(deletedOnly ? { deletedAt: { not: null } } : includeDeleted ? {} : { deletedAt: null }),
          ...(medium ? { medium } : {}),
          ...(favorite !== undefined ? { favorite } : {}),
          ...(updatedSince ? changedSince(updatedSince) : {}),
        },
      ],
    } satisfies Prisma.GameCollectionWhereInput;

    return this.paginate(where, query);
  }

  /**
   * Another user's collection, filtered to what the acting user may see: the
   * CASL read conditions grant own/household/friends/public scopes. An
   * anonymous viewer — a guest holding `AnonymousUser` instead of `User` —
   * reaches Public entries only, through those same conditions rather than a
   * branch of its own (#484). Tombstones are never exposed through this view.
   *
   * The scope is the path user's live entries; the viewer's ceiling is what
   * clips them (#514), so the viewer need not be a user at all. The medium
   * filter is caller input and sits beside the composed clause.
   *
   * Each row also says whether its game is on the acting user's wishlist
   * (`onWishlist`, #1241), so a client can show "a friend's copy of a game you
   * want" without a round trip per page.
   */
  async listForUser(
    targetUserId: string,
    query: ListUserGameCollectionsQueryDto,
  ): Promise<PaginatedRows<GameCollectionDto>> {
    const where = {
      AND: [
        this.scopeComposer.compose(ResourceType.GameCollection, Action.read, { userId: targetUserId, deletedAt: null }),
        query.medium ? { medium: query.medium } : {},
      ],
    } satisfies Prisma.GameCollectionWhereInput;

    const { rows, total } = await this.paginate(where, query);

    return { rows: await this.rowsWithOnWishlist(rows), total };
  }

  /**
   * Each row with `onWishlist` (#1241): one read of the acting user's
   * wishlist entries for the whole page. A wishlisted game marks every
   * platform game of it, a wishlisted platform game only itself.
   *
   * - `null`, not `false`, when the actor has no wishlist they can read: no
   *   acting user (plugin, system, external actors), no list read access (an
   *   anonymous user, an API key without a list grant), or a list read that
   *   doesn't reach the wishlist (a key whose list grant is pinned to one
   *   custom list). `false` would claim a wishlist was checked and lacked the
   *   game.
   * - The wishlist read is composed under the actor's list ceiling and sits in
   *   its own top-level query, so a deny-all fails closed and answers `null`.
   *   The access check up front only saves that query when the answer is
   *   already known.
   */
  private async rowsWithOnWishlist(rows: readonly GameCollectionRow[]): Promise<GameCollectionRow[]> {
    const userId = resolveActingUserIdOrNull(this.abilityService);

    if (userId === null || !this.canReadLists()) {
      return rows.map((row) => ({ ...row, onWishlist: null }));
    }

    const wishlisted = await readWishlistedPlatformGames(
      this.db,
      rows.map(({ platformGame }) => ({ id: platformGame.id, gameId: platformGame.game.id })),
      this.scopeComposer.compose(ResourceType.List, Action.read, { userId, kind: ListKind.Wishlist }),
    );

    return rows.map((row) => ({
      ...row,
      onWishlist: wishlisted === null ? null : wishlisted.has(row.platformGame.id),
    }));
  }

  /** Whether the actor can read any list at all (#1241). */
  private canReadLists(): boolean {
    return this.abilityService.getCurrentAccess([ResourceType.List])[ResourceType.List]?.[Action.read] !== 'none';
  }

  /**
   * One page of collection entries plus the total matching count for the
   * response envelope (#230).
   *
   * REPEATABLE READ because Prisma's default batch isolation snapshots each
   * statement separately, which can report fewer total rows than the page
   * itself contains. The identical `where` keeps the count scoped to what the
   * actor may see, and `id` breaks ties on `updatedAt` so a row cannot drift
   * across a page boundary between requests.
   */
  private async paginate(
    where: Prisma.GameCollectionWhereInput,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<GameCollectionRow>> {
    const [rows, total] = await this.db.$transaction(
      [
        this.db.gameCollection.findMany({
          where,
          include: COLLECTION_INCLUDE,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.gameCollection.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: await this.rowsWithBaseGames(rows), total };
  }

  /** A single entry the acting user may read (owner sees own tombstones). */
  async getById(id: string): Promise<GameCollectionDto> {
    const collection = await this.db.gameCollection.findUnique({
      where: {
        id,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.read),
      },
      include: COLLECTION_INCLUDE,
    });

    if (!collection) {
      throw collectionEntryNotFound(id);
    }

    return this.rowWithBaseGames(collection);
  }

  /**
   * Add a game to the acting user's collection, idempotent on the
   * `(user, platformGame, medium)` identity (#1231):
   *
   * - **No entry yet:** a new entry, created with one copy from `copy`.
   * - **A removed entry:** acquired again. Its own fields are updated and it
   *   gets one new copy from `copy`; the write runner then clears its removal
   *   and resumes the offers the removal paused (#1221).
   * - **An entry still owned:** only its own fields are updated. `copy` is not
   *   read, so a replayed add adds no copy.
   *
   * Play history (`playCount`, `lastPlayed`) and every field the add leaves
   * out survive a removal and an acquisition.
   *
   * Each case is checked against the row it writes (#1288): a new entry
   * against `create` with its user, platform game and medium, as
   * `ListService.create` checks a list; an existing one against `update`, on
   * the locked row and inside its write's `where`, as `PATCH` is. A key whose
   * grants are pinned to one entry therefore adds no other.
   *
   * The identity is locked `FOR UPDATE` first, as the transaction's first
   * lock, so the add takes turns with a nomination naming the entry, or with
   * its attendee coming back (#1221). When no entry exists the lock holds
   * nothing, and a concurrent first add of the same game may insert it too.
   * The second insert waits for the first to commit, then fails on the
   * entry's unique key, and the whole transaction runs once more, finding the
   * entry the other made.
   *
   * The platform game is read without a lock, so it can go before the insert
   * commits; the insert's foreign key then fails, and answers the same 404 as
   * a platform game that was never there.
   */
  async addToCollection(dto: CreateGameCollectionDto): Promise<GameCollectionDto> {
    const userId = this.abilityService.getActingUserId();
    const { platformGameId, medium, copy, ...attributes } = dto;

    const platformGame = await this.db.platformGame.findUnique({
      where: { id: platformGameId },
      select: { id: true },
    });
    if (!platformGame) {
      throw new NotFoundException(t('errors.platform_game.not_found', { id: platformGameId }));
    }

    const identity = { userId, platformGameId, medium };
    const described = copy ?? {};
    const provided = pickDefined(attributes);
    const now = new Date();

    const acquire = () =>
      this.writes.runForRow(
        async (tx) => {
          const [locked] = await tx.$queryRaw<{ deletedAt: Date | null; id: string }[]>(Prisma.sql`
            SELECT id, deleted_at AS "deletedAt"
            FROM game_collections
            WHERE user_id = ${userId} AND platform_game_id = ${platformGameId} AND medium = ${medium}::game_mediums
            FOR UPDATE
          `);

          if (locked === undefined) {
            this.abilityService.assertCurrentActorCan(Action.create, ResourceType.GameCollection, identity);

            const copyData = await copyCreateData(tx, described, identity, now);
            try {
              const created = await tx.gameCollection.create({
                data: { ...identity, ...provided, lastUpdated: now, copies: { create: copyData } },
                select: { id: true },
              });

              return created.id;
            } catch (error) {
              if (isPrismaForeignKeyConstraintError(error)) {
                throw new NotFoundException(t('errors.platform_game.not_found', { id: platformGameId }));
              }

              throw error;
            }
          }

          this.abilityService.assertCurrentActorCan(Action.update, ResourceType.GameCollection, {
            id: locked.id,
            ...identity,
            deletedAt: locked.deletedAt,
          });
          await this.writeEntryUnder(tx, locked.id, Action.update, {}, { ...provided, lastUpdated: now });

          if (locked.deletedAt !== null) {
            await assertCopyRoom(tx, locked.id);
            await tx.collectionCopy.create({
              data: { entryId: locked.id, ...(await copyCreateData(tx, described, identity, now)) },
            });
          }

          return locked.id;
        },
        userId,
        now,
      );

    return this.writtenRow(
      () => this.onceMoreOnIdentityViolation(acquire),
      (error) =>
        this.unexpected(error, `Error adding platform game ${platformGameId} to collection for user ${userId}`),
    );
  }

  /**
   * Patch the mutable fields of an entry. Standard REST semantics: omitted
   * fields are preserved, explicit `null` clears nullable fields. Identity
   * (`platformGameId`/`medium`) and play history (`playCount`/`lastPlayed`)
   * are not writable here, and neither are the copies' edition and count
   * (#1231).
   */
  async update(id: string, dto: UpdateGameCollectionDto): Promise<GameCollectionDto> {
    const data = pickDefined(dto);
    if (Object.keys(data).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    return this.writtenRow(
      () =>
        this.db.gameCollection.update({
          where: {
            id,
            // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.update),
          },
          data: { ...data, lastUpdated: new Date() },
          include: COLLECTION_INCLUDE,
        }),
      (error) => this.mapMissingToNotFound(error, id),
    );
  }

  /**
   * Remove a game from the collection: "I no longer own this", not "never
   * played" (#1231). Each copy the user still owns is removed, dated
   * `removedOn`, or today in UTC when the user gives no date, with the
   * reason; copies already removed or taken back keep what they have. The
   * write runner then removes the entry with its last owned copy, with that
   * reason. The entry stays, so play history and the rows that name it
   * (locations, offers) survive, and adding the game again brings it back.
   *
   * The entry's row is locked first, as the transaction's first lock
   * (#1221), then held to the `delete` conditions and to being live, inside
   * the check's `where`, so a key that may only update entries removes none
   * (#1288). A missing, foreign or already-removed entry answers
   * `COLLECTION_ENTRY_NOT_FOUND`, which a client may read as "already
   * removed" (#634). A removal dated after today, or before an owned copy was
   * acquired, is refused (#1231).
   *
   * Every live event that offers the entry stops counting it as supplied
   * (`syncCollectionEntrySupply`, #1221): the nominations of its game that
   * await an outcome pause, and it leaves the lineup of every date still
   * ahead. The offers themselves stay, and resume supplying when the game is
   * acquired again. The owner's answer is the removed entry, whatever the
   * sync changed.
   */
  async remove(id: string, { reason, removedOn }: RemoveGameCollectionQueryDto): Promise<GameCollectionDto> {
    const now = new Date();
    const actingUserId = resolveActingUserIdOrNull(this.abilityService);
    const removal = removalDate(removedOn, now);

    return this.writtenRow(
      () =>
        this.writes.runForRow(
          async (tx) => {
            if ((await this.writes.lockEntry(tx, id)) === null) {
              throw collectionEntryNotFound(id);
            }

            await this.writeEntryUnder(tx, id, Action.delete, { deletedAt: null }, { lastUpdated: now });

            const owned = await tx.collectionCopy.findMany({
              where: { entryId: id, ...OWNED_COPY },
              select: { acquiredOn: true, acquiredOnPrecision: true },
            });
            for (const { acquiredOn, acquiredOnPrecision } of owned) {
              assertRemovalAfterAcquisition(partialDateFromColumns(acquiredOn, acquiredOnPrecision), removal);
            }

            await tx.collectionCopy.updateMany({
              where: { entryId: id, ...OWNED_COPY },
              data: {
                removedAt: now,
                removedOn: removal.on,
                removedOnPrecision: removal.precision,
                removeReason: reason ?? null,
              },
            });

            return id;
          },
          actingUserId,
          now,
          reason ?? null,
        ),
      (error) => this.unexpected(error, `Error removing collection entry ${id}`),
    );
  }

  /**
   * Writes `data` to the entry, held to the actor's `action` conditions on it
   * and to `state`, inside the write's own `where`, as `PATCH` is (#1288). A
   * miss, whether the entry is outside the conditions or not in `state`,
   * answers `COLLECTION_ENTRY_NOT_FOUND`, as one that doesn't exist does
   * (#634).
   */
  private async writeEntryUnder(
    tx: Prisma.TransactionClient,
    id: string,
    action: Action,
    state: Pick<Prisma.GameCollectionWhereInput, 'deletedAt'>,
    data: Prisma.GameCollectionUncheckedUpdateInput,
  ): Promise<void> {
    try {
      await tx.gameCollection.update({
        where: {
          id,
          ...state,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, action),
        },
        data,
        select: { id: true },
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw collectionEntryNotFound(id);
      }

      throw error;
    }
  }

  /**
   * Runs `attempt`, and once more when it fails on the entry's identity
   * (#1231). Postgres aborts a transaction on the violation, so nothing
   * inside it can recover; the second run is a transaction of its own, and
   * reads what the other committed. A violation of any other unique would
   * only happen again, so it is thrown as it is, and so is a second one.
   */
  private async onceMoreOnIdentityViolation<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!isEntryIdentityViolation(error)) {
        throw error;
      }

      return attempt();
    }
  }

  /**
   * A write's failure as the client gets it. A refusal is an HTTP exception
   * already, and passes as it is; anything else is logged first.
   */
  private unexpected(error: unknown, context: string): unknown {
    if (!(error instanceof HttpException)) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`${context}: ${failure.message}`, failure.stack);
    }

    return error;
  }

  /**
   * Each row with its game's base games (#1070): the links whose base game is
   * live and the viewer could open by id, the rule `GET /games/:id` uses, and
   * that has a platform game on the row's platform (#1391). A game held more
   * than once on the page is read once.
   *
   * - A link read of its own, with the filter in its `where`: in
   *   `COLLECTION_INCLUDE` Prisma would drop a deny-all ceiling and name every
   *   base game (`docs/agents/gotchas.md`).
   * - The link's direction, not the game's content type, says which game is
   *   the base, so a row whose game is no expansion gets `[]`.
   * - The links are keyed by platform game: one add-on held on two platforms
   *   can list different base games on each row, and its `isStandalone`
   *   follows the platform game's own content type where it has one (#1391).
   * - The ceiling needs no user, so an anonymous viewer of another user's
   *   collection gets the base games it could open, the Public ones.
   *
   * Each row also sends the include's count of owned copies as its
   * `quantity`, and not the count's own shape (#1231).
   */
  private async rowsWithBaseGames(rows: readonly GameCollectionWithRelations[]): Promise<GameCollectionRow[]> {
    const links = await readBaseGameLinksOnPlatform(
      this.db,
      rows.map(({ platformGame }) => platformGame),
      this.scopeComposer.compose(ResourceType.Game, Action.read, { deletedAt: null }),
    );

    return rows.map(({ _count, platformGame, ...row }) => ({
      ...row,
      platformGame: {
        ...platformGame,
        game: { ...platformGame.game, baseGames: links.get(platformGame.id) ?? [] },
      },
      quantity: _count.copies,
    }));
  }

  /** One row with its game's base games, as {@link rowsWithBaseGames} reads them. */
  private async rowWithBaseGames(row: GameCollectionWithRelations): Promise<GameCollectionRow> {
    const [withLinks] = await this.rowsWithBaseGames([row]);

    return withLinks;
  }

  /**
   * The row a write returns, with its game's base games (#1070). `toError`
   * maps the write's own failure. The link read runs after that mapping,
   * never inside it, so a failed link read reaches the client as itself.
   */
  private async writtenRow(
    write: () => Promise<GameCollectionWithRelations>,
    toError: (error: unknown) => unknown,
  ): Promise<GameCollectionRow> {
    let row: GameCollectionWithRelations;
    try {
      row = await write();
    } catch (error) {
      throw toError(error);
    }

    return this.rowWithBaseGames(row);
  }

  /**
   * The update's scoped `where` matched no row: missing, or outside the
   * actor's CASL scope. Both collapse to 404 so foreign rows are
   * indistinguishable from absent ones (mirrors FriendshipService).
   */
  private mapMissingToNotFound(error: unknown, id: string) {
    if (isPrismaDependentRecordNotFoundError(error)) {
      return collectionEntryNotFound(id);
    }

    this.logger.error(`Error mutating collection entry with id ${id}`, error);
    return error instanceof Error ? error : new Error(String(error));
  }
}
