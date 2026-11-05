import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  Prisma,
  readBaseGameLinks,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto, pickDefined } from '@bge/shared';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  changedSince,
  COLLECTION_INCLUDE,
  type GameCollectionRow,
  type GameCollectionWithRelations,
} from './collection-row';
import {
  CreateGameCollectionDto,
  GameCollectionDto,
  ListGameCollectionsQueryDto,
  ListUserGameCollectionsQueryDto,
  RemoveGameCollectionQueryDto,
  UpdateGameCollectionDto,
} from './dto';

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

    return this.paginate(where, query);
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

    return { rows: await this.withBaseGames(rows), total };
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
      throw new NotFoundException(t('errors.game_collection.not_found', { id }));
    }

    return this.withRowBaseGames(collection);
  }

  /**
   * Add a game to the acting user's collection. Idempotent upsert on the
   * `(user, platformGame, medium)` identity: re-adding an active entry updates
   * the provided fields, and re-adding a removed entry resurrects it — the
   * tombstone is cleared while server-managed play history (`playCount`,
   * `lastPlayed`) and any unspecified fields survive the remove→re-add cycle.
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

    let collection: GameCollectionWithRelations;
    try {
      collection = await this.db.gameCollection.upsert({
        where: { userId_platformGameId_medium: { userId, platformGameId, medium } },
        create: { userId, platformGameId, medium, ...provided, lastUpdated },
        update: { ...provided, deletedAt: null, deleteReason: null, lastUpdated },
        include: COLLECTION_INCLUDE,
      });
    } catch (error) {
      this.logger.error(`Error adding platform game ${platformGameId} to collection for user ${userId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new NotFoundException(t('errors.platform_game.not_found', { id: platformGameId }));
      }

      throw error;
    }

    // After the write's catch, so a failed link read is not taken for a
    // missing platform game (#1070).
    return this.withRowBaseGames(collection);
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
        throw new NotFoundException(t('errors.game_collection.not_found', { id }));
      }

      await this.assertReleaseBelongsTo(data.releaseId, existing.platformGameId);
    }

    let collection: GameCollectionWithRelations;
    try {
      collection = await this.db.gameCollection.update({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.update),
        },
        data: { ...data, lastUpdated: new Date() },
        include: COLLECTION_INCLUDE,
      });
    } catch (error) {
      throw this.mapMissingToNotFound(error, id);
    }

    // After the write's catch, so a failed link read is never mapped to 404
    // (#1070).
    return this.withRowBaseGames(collection);
  }

  /**
   * Remove a game from the collection — "I no longer own this", not "never
   * played". A tombstone, never a hard delete: play history must survive a
   * remove→re-add cycle, and child rows (locations, event game lists, loans)
   * would otherwise cascade away.
   */
  async remove(id: string, { reason }: RemoveGameCollectionQueryDto): Promise<GameCollectionDto> {
    const now = new Date();

    // Single scoped write: `deletedAt: null` in the filter makes a repeat
    // delete (or a foreign/missing row) miss and surface as 404.
    let collection: GameCollectionWithRelations;
    try {
      collection = await this.db.gameCollection.update({
        where: {
          id,
          deletedAt: null,
          // eslint-disable-next-line no-restricted-syntax -- single-row soft delete by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.delete),
        },
        data: { deletedAt: now, deleteReason: reason ?? null, lastUpdated: now },
        include: COLLECTION_INCLUDE,
      });
    } catch (error) {
      throw this.mapMissingToNotFound(error, id);
    }

    // After the write's catch, so a failed link read is never mapped to 404
    // (#1070).
    return this.withRowBaseGames(collection);
  }

  /**
   * Each row with its game's base games (#1070): the links whose base game is
   * live and the viewer could open by id, the rule `GET /games/:id` uses. A
   * game held more than once on the page is read once.
   *
   * - A link read of its own, with the filter in its `where`: in
   *   `COLLECTION_INCLUDE` Prisma would drop a deny-all ceiling and name every
   *   base game (`docs/agents/gotchas.md`).
   * - The link's direction, not the game's content type, says which game is
   *   the base, so a row whose game is no expansion gets `[]`.
   * - The ceiling needs no user, so an anonymous viewer of another user's
   *   collection gets the base games it could open, the Public ones.
   */
  private async withBaseGames(rows: readonly GameCollectionWithRelations[]): Promise<GameCollectionRow[]> {
    const links = await readBaseGameLinks(
      this.db,
      [...new Set(rows.map((row) => row.platformGame.game.id))],
      this.scopeComposer.compose(ResourceType.Game, Action.read, { deletedAt: null }),
    );

    return rows.map(({ platformGame, ...row }) => ({
      ...row,
      platformGame: {
        ...platformGame,
        game: { ...platformGame.game, baseGames: links.get(platformGame.game.id) ?? [] },
      },
    }));
  }

  /** One row with its game's base games, as {@link withBaseGames} reads them. */
  private async withRowBaseGames(row: GameCollectionWithRelations): Promise<GameCollectionRow> {
    const [withLinks] = await this.withBaseGames([row]);

    return withLinks;
  }

  /**
   * The scoped `where` matched no row: missing, already tombstoned (remove), or
   * outside the actor's CASL scope. All collapse to 404 so foreign rows are
   * indistinguishable from absent ones (mirrors FriendshipService).
   */
  private mapMissingToNotFound(error: unknown, id: string) {
    if (isPrismaDependentRecordNotFoundError(error)) {
      return new NotFoundException(t('errors.game_collection.not_found', { id }));
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
