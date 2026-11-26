import {
  Action,
  constraintIdentity,
  DatabaseService,
  identifiesConstraint,
  isPrismaForeignKeyConstraintError,
  ListKind,
  Prisma,
  readBaseGameLinksOnPlatform,
  readWishlistedPlatformGames,
  ResourceType,
} from '@bge/database';
import type { CodedHttpException } from '@bge/i18n';
import { t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto, pickDefined } from '@bge/shared';
import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import {
  addCopy,
  assertRemovableOn,
  copyCreateData,
  copyRemovalData,
  isCopyReleaseViolation,
  removalOf,
} from './collection-copy-data';
import { appendRatingChangeIfChanged } from './collection-rating.service';
import { COPY_REVISION_SELECT, recordCopyRevisions } from './collection-revisions';
import type { GameCollectionRow, GameCollectionWithRelations } from './collection-row';
import { changedSince, COLLECTION_INCLUDE, OWNED_COPY, readOwnerCopies } from './collection-row';
import { CollectionWriteService, writeEntryUnder } from './collection-write.service';
import {
  CreateGameCollectionDto,
  GameCollectionDto,
  ListGameCollectionsQueryDto,
  ListUserGameCollectionsQueryDto,
  RemoveGameCollectionQueryDto,
  UpdateGameCollectionDto,
} from './dto';
import { collectionEntryNotFound, platformGameNotFound, releaseNotFound } from './game-collection.errors';
import type { PartialDate } from './values/partial-date';
import { defaultRemovalDate, givenRemovalDate } from './values/partial-date';

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
 * The refusal for a new entry's insert that failed on a foreign key (#1231):
 * a row read before the insert went since. The copy's release, named by its
 * trigger or its foreign key, answers `GAME_RELEASE_NOT_FOUND`; anything else
 * answers `PLATFORM_GAME_NOT_FOUND`, as the add's only other reference is its
 * platform game. That includes a failure whose constraint can't be named,
 * which is the answer this insert gave before it could tell them apart.
 */
function vanishedReference(
  error: unknown,
  platformGameId: string,
  releaseId: string | null | undefined,
): CodedHttpException {
  if (releaseId != null && isCopyReleaseViolation(error)) {
    return releaseNotFound(releaseId);
  }

  return platformGameNotFound(platformGameId);
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
   *
   * Each row carries its copies in the entry owner's shape (#1231).
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

    return this.paginate(where, query, true);
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
   *
   * Its copies are the public shape for every caller, the path user too: this
   * is the route other readers read, so its rows never read the entry
   * owner's (#1231).
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

    const { rows, total } = await this.paginate(where, query, false);

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
   * response envelope (#230), composed by {@link composeRows}, with the
   * entry owner's copies when `ownerCopies` is set (#1231).
   *
   * REPEATABLE READ because Prisma's default isolation snapshots each
   * statement separately, which can report fewer total rows than the page
   * itself contains, or a row's `quantity` beside a different set of its
   * copies (#1231). Every read of the page, the composing ones included, is
   * in the one snapshot. The identical `where` keeps the count scoped to what
   * the actor may see, and `id` breaks ties on `updatedAt` so a row cannot
   * drift across a page boundary between requests.
   */
  private async paginate(
    where: Prisma.GameCollectionWhereInput,
    pagination: PaginationQueryDto,
    ownerCopies: boolean,
  ): Promise<PaginatedRows<GameCollectionRow>> {
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.gameCollection.findMany({
          where,
          include: COLLECTION_INCLUDE,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        });
        const total = await tx.gameCollection.count({ where });

        return { rows: await this.composeRows(tx, rows, ownerCopies), total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * A single entry the acting user may read; the entry's owner also reads it once
   * removed. Its copies are the entry owner's shape for its owner, and the public
   * shape for every other reader (#1231).
   */
  async getById(id: string): Promise<GameCollectionDto> {
    // One REPEATABLE READ snapshot, as `paginate` reads a page in (#1231).
    return this.db.$transaction(
      async (tx) => {
        const collection = await tx.gameCollection.findUnique({
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

        const [row] = await this.composeRows(tx, [collection], true);

        return row;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Each row with its copies in the entry owner's shape, for the rows the acting
   * user owns (#1231). `readOwnerCopies` decides which those are, in one
   * query bound to the acting user as the entries' owner; every other row
   * keeps the public copies the include read. An actor with no user behind
   * it owns no entry, so nothing is read for it.
   *
   * An API key acts for the user who made it, so its rows carry the entry owner's shape, as
   * the copy routes already send it. The key reads only the entries its
   * grants reach, and this read only adds to those rows.
   */
  private async rowsWithOwnerCopies(
    tx: Prisma.TransactionClient,
    rows: GameCollectionRow[],
  ): Promise<GameCollectionRow[]> {
    const actingUserId = resolveActingUserIdOrNull(this.abilityService);
    if (actingUserId === null || rows.length === 0) {
      return rows;
    }

    const owned = await readOwnerCopies(
      tx,
      rows.map(({ id }) => id),
      actingUserId,
    );

    return rows.map((row) => ({ ...row, copies: owned.get(row.id) ?? row.copies }));
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
   * A rating the add carries is a change of the entry's rating, kept in the
   * history dated today: the first one for a new entry, and one for an
   * existing entry only when it differs from the rating the locked row holds,
   * so a replayed add appends nothing (#1231).
   *
   * The platform game and the copy's release are read without a lock, so
   * either can go before the insert commits. The insert's foreign key then
   * fails, and answers the same 404 as a platform game or release that was
   * never there: `PLATFORM_GAME_NOT_FOUND` or `GAME_RELEASE_NOT_FOUND`.
   */
  async addToCollection(dto: CreateGameCollectionDto): Promise<GameCollectionDto> {
    const userId = this.abilityService.getActingUserId();
    const { platformGameId, medium, copy, ...attributes } = dto;

    const platformGame = await this.db.platformGame.findUnique({
      where: { id: platformGameId },
      select: { id: true },
    });
    if (!platformGame) {
      throw platformGameNotFound(platformGameId);
    }

    const identity = { userId, platformGameId, medium };
    const described = copy ?? {};
    const provided = pickDefined(attributes);
    const now = new Date();

    const acquire = () =>
      this.writes.runForRow(
        async (tx) => {
          const [locked] = await tx.$queryRaw<
            { deletedAt: Date | null; id: string; rating: number | null }[]
          >(Prisma.sql`
            SELECT id, deleted_at AS "deletedAt", rating
            FROM game_collections
            WHERE user_id = ${userId} AND platform_game_id = ${platformGameId} AND medium = ${medium}::game_mediums
            FOR UPDATE
          `);

          if (locked === undefined) {
            this.abilityService.assertCurrentActorCan(Action.create, ResourceType.GameCollection, identity);

            const copyData = await copyCreateData(tx, described, identity, now);
            let createdId: string;
            try {
              const created = await tx.gameCollection.create({
                data: { ...identity, ...provided, lastUpdated: now, copies: { create: copyData } },
                select: { id: true },
              });
              createdId = created.id;
            } catch (error) {
              if (isPrismaForeignKeyConstraintError(error)) {
                throw vanishedReference(error, platformGameId, described.releaseId);
              }

              throw error;
            }

            // A new entry had no rating, so a null sends nothing to clear and
            // its history starts empty (#1231).
            await appendRatingChangeIfChanged(tx, createdId, provided.rating, null, now);

            return createdId;
          }

          this.abilityService.assertCurrentActorCan(Action.update, ResourceType.GameCollection, {
            id: locked.id,
            ...identity,
            deletedAt: locked.deletedAt,
          });
          await writeEntryUnder(
            tx,
            this.abilityService,
            locked.id,
            Action.update,
            {},
            { ...provided, lastUpdated: now },
          );

          await appendRatingChangeIfChanged(tx, locked.id, provided.rating, locked.rating, now);

          if (locked.deletedAt !== null) {
            await addCopy(tx, { ...identity, id: locked.id }, described, now);
          }

          return locked.id;
        },
        (tx, entryId) => this.readWrittenRow(tx, entryId),
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
   *
   * A rating that differs from the entry's current one is a change of the
   * rating, kept in its history dated today, clearing it included. The
   * current rating is read under the entry's lock, the transaction's first
   * lock, so two patches can't both compare against the old rating and
   * append twice (#1231). The lock is taken only on an entry inside the
   * update conditions (`lockEntryUnder`), and the entry is then written
   * under them, as ever; a miss answers `COLLECTION_ENTRY_NOT_FOUND` and the
   * transaction keeps nothing.
   *
   * The patch changes no copy, so it needs no reconcile, supply sync or emit
   * (#1221): a plain transaction, not the write runner.
   */
  async update(id: string, dto: UpdateGameCollectionDto): Promise<GameCollectionDto> {
    const data = pickDefined(dto);
    if (Object.keys(data).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const now = new Date();

    return this.writtenRow(
      () =>
        this.db.$transaction(async (tx) => {
          await this.writes.lockEntryUnder(tx, this.abilityService, id, Action.update);

          const current =
            data.rating === undefined
              ? null
              : await tx.gameCollection.findUniqueOrThrow({ where: { id }, select: { rating: true } });

          await writeEntryUnder(tx, this.abilityService, id, Action.update, {}, { ...data, lastUpdated: now });

          await appendRatingChangeIfChanged(tx, id, data.rating, current?.rating ?? null, now);

          return this.readWrittenRow(tx, id);
        }),
      (error) => this.unexpected(error, `Error updating collection entry ${id}`),
    );
  }

  /**
   * Remove a game from the collection: "I no longer own this", not "never
   * played" (#1231). Each copy the user still owns is removed, dated
   * `removedOn`, or, when the user gives no date, today in UTC, or the copy's
   * acquisition day when that is later (`removalOf`), with the
   * reason, and stamped as edited by the user so a sync never undoes it;
   * each first keeps what it said before as a revision, which restoring
   * undoes the removal (#1231). Copies already removed or taken back keep
   * what they have. The
   * write runner then removes the entry with its last owned copy, with that
   * reason. The entry stays, so play history and the rows that name it
   * (locations, offers) survive, and adding the game again brings it back.
   *
   * The entry's row is locked first, as the transaction's first lock
   * (#1221), and only when it is inside the `delete` conditions
   * (`lockEntryUnder`), then held to them and to being live, inside
   * the check's `where`, so a key that may only update entries removes none
   * (#1288). A missing, foreign or already-removed entry answers
   * `COLLECTION_ENTRY_NOT_FOUND`, which a client may read as "already
   * removed" (#634). A removal dated on a day that is today nowhere yet, or
   * before an owned copy was acquired, is refused (#1231).
   *
   * Every live event that offers the entry stops counting it as supplied
   * (`syncCollectionEntrySupply`, #1221): the nominations of its game that
   * await an outcome pause, and it leaves the lineup of every date still
   * ahead. The offers themselves stay, and resume supplying when the game is
   * acquired again. The answer, to the entry's owner, is the removed entry, whatever the
   * sync changed.
   */
  async remove(id: string, { reason, removedOn }: RemoveGameCollectionQueryDto): Promise<GameCollectionDto> {
    const now = new Date();
    const actingUserId = resolveActingUserIdOrNull(this.abilityService);
    const given = givenRemovalDate(removedOn, now);

    return this.writtenRow(
      () =>
        this.writes.runForRow(
          async (tx) => {
            await this.writes.lockEntryUnder(tx, this.abilityService, id, Action.delete);

            await writeEntryUnder(
              tx,
              this.abilityService,
              id,
              Action.delete,
              { deletedAt: null },
              { lastUpdated: now },
            );

            const owned = await tx.collectionCopy.findMany({
              where: { entryId: id, ...OWNED_COPY },
              select: COPY_REVISION_SELECT,
            });

            // Each copy is dated by itself, so a copy acquired tomorrow in
            // UTC is not removed before it was acquired (#1231).
            const removals = new Map<string, { copyIds: string[]; removal: PartialDate }>();
            for (const copy of owned) {
              const removal = removalOf(copy, given, now);
              assertRemovableOn(copy, removal);

              const key = `${removal.on.toISOString()}/${removal.precision}`;
              const group = removals.get(key) ?? { copyIds: [], removal };
              group.copyIds.push(copy.id);
              removals.set(key, group);
            }

            // A removal edits each copy it removes, so each keeps what it
            // said before as a revision, read under the entry's lock (#1231).
            await recordCopyRevisions(tx, owned);

            // Every copy on one date, which is every removal that names a
            // date and nearly every other, is one statement over the entry's
            // owned copies, as the entry's lock holds them still. Only copies
            // that differ are written apart, each date by its copies' ids.
            const dated = [...removals.values()];
            if (dated.length <= 1) {
              const removal = dated[0]?.removal ?? given ?? defaultRemovalDate(null, now);
              await tx.collectionCopy.updateMany({
                where: { entryId: id, ...OWNED_COPY },
                data: copyRemovalData(removal, reason, now),
              });
            } else {
              for (const { copyIds, removal } of dated) {
                await tx.collectionCopy.updateMany({
                  where: { id: { in: copyIds }, entryId: id, ...OWNED_COPY },
                  data: copyRemovalData(removal, reason, now),
                });
              }
            }

            return id;
          },
          (tx, entryId) => this.readWrittenRow(tx, entryId),
          actingUserId,
          now,
          reason ?? null,
        ),
      (error) => this.unexpected(error, `Error removing collection entry ${id}`),
    );
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
  private async rowsWithBaseGames(
    tx: Prisma.TransactionClient,
    rows: readonly GameCollectionWithRelations[],
  ): Promise<GameCollectionRow[]> {
    const links = await readBaseGameLinksOnPlatform(
      tx,
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

  /**
   * `rows` as the routes send them (#1231): each with its game's base games
   * ({@link rowsWithBaseGames}), and, given `ownerCopies`, the entry owner's
   * copies on the rows the acting user owns ({@link rowsWithOwnerCopies}).
   *
   * Read in `tx`, the transaction that read `rows`, so a row's `quantity`,
   * the include's count, and the copies it carries are one state of the
   * entry: a list or a single read holds one REPEATABLE READ snapshot, and a
   * write's transaction holds the entry's lock, which every copy write takes
   * first. Read apart, a copy write committed between them could answer a
   * `quantity` of 2 beside one copy.
   */
  private async composeRows(
    tx: Prisma.TransactionClient,
    rows: readonly GameCollectionWithRelations[],
    ownerCopies: boolean,
  ): Promise<GameCollectionRow[]> {
    const withBaseGames = await this.rowsWithBaseGames(tx, rows);

    return ownerCopies ? this.rowsWithOwnerCopies(tx, withBaseGames) : withBaseGames;
  }

  /**
   * The entry a write answers, read in the write's transaction after the
   * write, and composed there for its owner ({@link composeRows}, #1231).
   */
  private async readWrittenRow(tx: Prisma.TransactionClient, id: string): Promise<GameCollectionRow> {
    const row = await tx.gameCollection.findUniqueOrThrow({ where: { id }, include: COLLECTION_INCLUDE });
    const [composed] = await this.composeRows(tx, [row], true);

    return composed;
  }

  /**
   * The row a write returns, read and composed in the write's own
   * transaction ({@link readWrittenRow}). `toError` maps its failure, a
   * failed read included, which rolls the write back with it (#1231).
   */
  private async writtenRow(
    write: () => Promise<GameCollectionRow>,
    toError: (error: unknown) => unknown,
  ): Promise<GameCollectionRow> {
    try {
      return await write();
    } catch (error) {
      throw toError(error);
    }
  }
}
