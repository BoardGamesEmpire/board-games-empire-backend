import type { GameCollection } from '@bge/database';
import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  ListKind,
  Prisma,
  readBaseGameLinksOnPlatform,
  readWishlistedPlatformGames,
  ResourceType,
} from '@bge/database';
import { emitCollectionSupplyChanges, syncCollectionEntrySupply } from '@bge/event';
import { CodedHttpException, t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto, pickDefined } from '@bge/shared';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createId } from '@paralleldrive/cuid2';
import { Http } from '@status/codes';
import type { GameCollectionRow, GameCollectionWithRelations } from './collection-row';
import { changedSince, COLLECTION_INCLUDE } from './collection-row';
import {
  CreateGameCollectionDto,
  GameCollectionDto,
  ListGameCollectionsQueryDto,
  ListUserGameCollectionsQueryDto,
  RemoveGameCollectionQueryDto,
  UpdateGameCollectionDto,
} from './dto';

/**
 * The refusal for a collection entry the actor can't see: missing, already
 * removed, or outside their scope, which the 404 never tells apart. Its code
 * says the 404 is about this row, so a client may read it as "already removed"
 * and complete a queued removal, where a 404 without it (a route that moved,
 * an id that matched no route) may not (#634).
 */
function collectionEntryNotFound(id: string): CodedHttpException {
  return new CodedHttpException(
    Http.NotFound,
    'COLLECTION_ENTRY_NOT_FOUND',
    t('errors.game_collection.not_found', { id }),
  );
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
    private readonly eventEmitter: EventEmitter2,
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
   * Add a game to the acting user's collection. Idempotent upsert on the
   * `(user, platformGame, medium)` identity: re-adding an active entry updates
   * the provided fields, and adding back a removed entry clears its removal,
   * while server-managed play history (`playCount`, `lastPlayed`) and any
   * unspecified fields survive the removal and the add-back.
   *
   * Adding back a removed entry also resumes the nominations its removal
   * paused, in every live event that offers it
   * (`syncCollectionEntrySupply`, #1221). The entry's row is locked
   * `FOR UPDATE` before the write, as the transaction's first lock, so a
   * nomination naming the entry, or an attendee offering it coming back,
   * takes turns with the add-back: whichever comes second waits, then reads
   * what the first committed. A new entry, or one never removed, has nothing
   * paused, so it runs no sync. The changes are emitted once the transaction
   * commits.
   *
   * When the pre-read finds no row, the `FOR UPDATE` locks nothing, and
   * another request may create the entry, offer it and remove it before the
   * upsert, which then adds that row back. The id the create would use is
   * minted here, so an upsert that answers another id updated a row it did
   * not create, and runs the sync on it as well. Its `UPDATE` is then the
   * first lock on the row. A genuine create answers the minted id and runs
   * no sync.
   */
  async addToCollection(dto: CreateGameCollectionDto): Promise<GameCollectionDto> {
    const userId = this.abilityService.getActingUserId();
    const { platformGameId, medium, releaseId, ...attributes } = dto;

    const platformGame = await this.db.platformGame.findUnique({
      where: { id: platformGameId },
      select: { id: true },
    });
    if (!platformGame) {
      throw new NotFoundException(t('errors.platform_game.not_found', { id: platformGameId }));
    }

    if (releaseId) {
      await this.assertReleaseBelongsTo(releaseId, platformGameId);
    }

    const provided = pickDefined({ ...attributes, releaseId });
    const lastUpdated = new Date();
    // The schema's own default, cuid2, minted here so the upsert's answer
    // says whether it created the row (#1221).
    const newId = createId();

    return this.writtenRow(
      () =>
        this.writeThenSyncSupply(
          async (tx) => {
            const [locked] = await tx.$queryRaw<{ deletedAt: Date | null }[]>(Prisma.sql`
              SELECT deleted_at AS "deletedAt"
              FROM game_collections
              WHERE user_id = ${userId} AND platform_game_id = ${platformGameId} AND medium = ${medium}::game_mediums
              FOR UPDATE
            `);

            const row = await tx.gameCollection.upsert({
              where: { userId_platformGameId_medium: { userId, platformGameId, medium } },
              create: { id: newId, userId, platformGameId, medium, ...provided, lastUpdated },
              update: { ...provided, deletedAt: null, deleteReason: null, lastUpdated },
              include: COLLECTION_INCLUDE,
            });

            // Removed when locked, or created by another request since the
            // pre-read and possibly removed in that window.
            const addedBack = locked === undefined ? row.id !== newId : locked.deletedAt !== null;

            return { row, synced: addedBack ? { id: row.id, deletedAt: null } : null };
          },
          userId,
          lastUpdated,
        ),
      (error) => {
        this.logger.error(`Error adding platform game ${platformGameId} to collection for user ${userId}`, error);

        return isPrismaDependentRecordNotFoundError(error)
          ? new NotFoundException(t('errors.platform_game.not_found', { id: platformGameId }))
          : error;
      },
    );
  }

  /**
   * Patch the mutable fields of an entry. Standard REST semantics: omitted
   * fields are preserved, explicit `null` clears nullable fields. Identity
   * (`platformGameId`/`medium`) and play history (`playCount`/`lastPlayed`)
   * are not writable here.
   */
  async update(id: string, dto: UpdateGameCollectionDto): Promise<GameCollectionDto> {
    const data = pickDefined(dto);
    if (Object.keys(data).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    // Only a release change needs a pre-read (the row's platform game); every
    // other patch goes straight to the scoped update.
    if (data.releaseId) {
      const existing = await this.db.gameCollection.findUnique({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row pre-read for a write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.update),
        },
        select: { platformGameId: true },
      });

      if (!existing) {
        throw collectionEntryNotFound(id);
      }

      await this.assertReleaseBelongsTo(data.releaseId, existing.platformGameId);
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
   * played". The entry stays, marked removed, so play history and the rows
   * that name it (locations, offers, loans) survive a removal and an add-back.
   *
   * Every live event that offers the entry stops counting it as supplied
   * (`syncCollectionEntrySupply`, #1221): the nominations of its game that
   * await an outcome pause, and it leaves the lineup of every date still
   * ahead. The offers themselves stay, and resume supplying when the game is
   * added back. The removal's `UPDATE` is the transaction's first lock, on
   * the entry's row, so a nomination naming the entry takes turns with it.
   * The changes are emitted once the transaction commits. The owner's answer
   * is the removed entry, whatever the sync changed.
   */
  async remove(id: string, { reason }: RemoveGameCollectionQueryDto): Promise<GameCollectionDto> {
    const now = new Date();
    const actingUserId = resolveActingUserIdOrNull(this.abilityService);

    // Single scoped write: `deletedAt: null` in the filter makes a repeat
    // removal (or a foreign/missing row) miss and surface as 404, which rolls
    // the transaction back before the sync runs.
    return this.writtenRow(
      () =>
        this.writeThenSyncSupply(
          async (tx) => {
            const row = await tx.gameCollection.update({
              where: {
                id,
                deletedAt: null,
                // eslint-disable-next-line no-restricted-syntax -- single-row removal by id, not a collection read
                AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.delete),
              },
              data: { deletedAt: now, deleteReason: reason ?? null, lastUpdated: now },
              include: COLLECTION_INCLUDE,
            });

            return { row, synced: { id: row.id, deletedAt: now } };
          },
          actingUserId,
          now,
        ),
      (error) => this.mapMissingToNotFound(error, id),
    );
  }

  /**
   * Runs `write`, then `syncCollectionEntrySupply` on the entry state it
   * answers, in one transaction, and emits what the sync changed once that
   * commits (#1221). A `write` that answers `synced: null` runs no sync and
   * emits nothing. Its first statement must lock the entry's row, as the
   * transaction's first lock, so every write that changes what the entry
   * supplies takes turns with it (`syncCollectionEntrySupply`).
   *
   * The transaction keeps the default isolation, READ COMMITTED: the sync
   * relies on each of its statements reading what had committed when it
   * started.
   */
  private async writeThenSyncSupply(
    write: (tx: Prisma.TransactionClient) => Promise<{
      row: GameCollectionWithRelations;
      synced: Pick<GameCollection, 'id' | 'deletedAt'> | null;
    }>,
    actingUserId: string | null,
    now: Date,
  ): Promise<GameCollectionWithRelations> {
    const { row, supplyChanges } = await this.db.$transaction(async (tx) => {
      const { row, synced } = await write(tx);

      return { row, supplyChanges: synced ? await syncCollectionEntrySupply(tx, synced, now) : null };
    });

    if (supplyChanges) {
      emitCollectionSupplyChanges(this.eventEmitter, supplyChanges, actingUserId, now);
    }

    return row;
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
   */
  private async rowsWithBaseGames(rows: readonly GameCollectionWithRelations[]): Promise<GameCollectionRow[]> {
    const links = await readBaseGameLinksOnPlatform(
      this.db,
      rows.map(({ platformGame }) => platformGame),
      this.scopeComposer.compose(ResourceType.Game, Action.read, { deletedAt: null }),
    );

    return rows.map(({ platformGame, ...row }) => ({
      ...row,
      platformGame: {
        ...platformGame,
        game: { ...platformGame.game, baseGames: links.get(platformGame.id) ?? [] },
      },
    }));
  }

  /** One row with its game's base games, as {@link rowsWithBaseGames} reads them. */
  private async rowWithBaseGames(row: GameCollectionWithRelations): Promise<GameCollectionRow> {
    const [withLinks] = await this.rowsWithBaseGames([row]);

    return withLinks;
  }

  /**
   * The row a write returns, with its game's base games (#1070). `toError`
   * maps the write's own failure, a missing row to 404 in every caller. The
   * link read runs after that mapping, never inside it, so a failed link read
   * reaches the client as itself.
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
   * The scoped `where` matched no row: missing, already tombstoned (remove), or
   * outside the actor's CASL scope. All collapse to 404 so foreign rows are
   * indistinguishable from absent ones (mirrors FriendshipService).
   */
  private mapMissingToNotFound(error: unknown, id: string) {
    if (isPrismaDependentRecordNotFoundError(error)) {
      return collectionEntryNotFound(id);
    }

    this.logger.error(`Error mutating collection entry with id ${id}`, error);
    return error instanceof Error ? error : new Error(String(error));
  }

  private async assertReleaseBelongsTo(releaseId: string, platformGameId: string) {
    const release = await this.db.gameRelease.findUnique({
      where: { id: releaseId },
      select: { platformGameId: true },
    });

    if (!release) {
      throw new NotFoundException(t('errors.game_release.not_found', { id: releaseId }));
    }

    if (release.platformGameId !== platformGameId) {
      throw new BadRequestException(
        t('errors.game_collection.release_platform_mismatch', { releaseId, platformGameId }),
      );
    }
  }
}
