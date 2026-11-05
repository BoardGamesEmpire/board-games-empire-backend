import { sanitizeMarkdown } from '@bge/content-format';
import {
  Action,
  DatabaseService,
  gameSummaryReader,
  isPrismaDependentRecordNotFoundError,
  Prisma,
  Reach,
  readBaseGameLinks,
  ResourceType,
  type GameSummary,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { sampleByOffsets, type PaginatedRows, type RandomSampleQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { DataGatewayLink } from './data-gateway-link';
import {
  CreateGameDto,
  GAME_DESCRIPTION_MAX_LENGTH,
  ListGamesQueryDto,
  UpdateGameDto,
  type GameDetailDto,
  type GameListItemDto,
  type GameSort,
} from './dto';
import { GAME_DETAIL_INCLUDE } from './game-detail.include';
import { gameListScope } from './game-list-scope';
import { LINKED_GAME_SELECT } from './linked-game.select';
import { PLATFORM_GAME_DETAIL_SELECT } from './platform-game-detail.select';

/** A game's ranges, each as its minimum's field and its maximum's. */
const GAME_RANGES = [
  ['minPlayers', 'maxPlayers'],
  ['minPlayTime', 'maxPlayTime'],
] as const;

type GameRangeField = (typeof GAME_RANGES)[number][number];

/** The order each sort on `GET /games` names (#959). */
const GAME_ORDERS: Record<GameSort, Prisma.GameOrderByWithRelationInput[]> = {
  // A game catalog reads best alphabetically, and `title` is not unique — two
  // editions of the same game share one — so `id` completes the order.
  // Without a total order the database may return page 2 overlapping page 1.
  title: [{ title: 'asc' }, { id: 'asc' }],
  // The games most recently added to the game catalog first (#959). The id breaks a tie, as it does for title.
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
};

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of the catalog plus the total matching row count for the response
   * envelope (#372). Rows and count share a REPEATABLE READ transaction: under
   * the database default each statement takes its own snapshot, so a concurrent
   * create between them makes `total` — and the `hasMore` derived from it —
   * describe a catalog the caller was never served.
   *
   * The scope is the set {@link gameListScope} names, and the ceiling only
   * clips it (#513).
   * For an `apiKey` actor it carries the key ∩ owner floor.
   * `sort` picks the order and never the set (#959).
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors:
   * half the scope is the caller's own games, which has no meaning without a
   * user, and the refusal must never soften into a page of Public games.
   * PROVISIONAL — #395.
   *
   * Each row's `baseGames` names, for an expansion, the base games it
   * attaches to that pass the same `where` as the page (#1069). A base-game
   * id on a row then always means "this game is on some page of your list".
   * The links are read after the transaction: they describe rows already
   * chosen, and a link or a base game's visibility that changes between the
   * two reads only adds or removes a name, never a row.
   */
  async getGames(query: ListGamesQueryDto): Promise<PaginatedRows<GameListItemDto>> {
    const userId = resolveScopeSubjectId(this.abilityService);
    const where = this.scopeComposer.compose(ResourceType.Game, Action.read, gameListScope(userId));

    const [rows, total] = await this.db.$transaction(
      [
        this.db.game.findMany({
          where,
          orderBy: GAME_ORDERS[query.sort],
          skip: query.skip,
          take: query.pageSize,
        }),

        this.db.game.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const links = await readBaseGameLinks(
      this.db,
      rows.map((row) => row.id),
      where,
    );

    return { rows: rows.map((row) => ({ ...row, baseGames: links.get(row.id) ?? [] })), total };
  }

  /**
   * Up to `size` games picked uniformly at random from the set `GET /games`
   * lists for the caller, in random order, each as the game summary (#961).
   * A new member's home page falls back to it, so it never shows a game
   * the caller could not open.
   *
   * The set may be the whole game catalog, so the sample is read one game per
   * random offset, walking the offsets in order, rather than by loading every
   * id. The count and the reads
   * share one REPEATABLE READ transaction: the offsets index the counted set,
   * and under the database default a game deleted between them would shift
   * every offset after it.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors,
   * as for {@link getGames}. PROVISIONAL — #395.
   */
  async getRandomGames(query: RandomSampleQueryDto): Promise<GameSummary[]> {
    const userId = resolveScopeSubjectId(this.abilityService);
    const where = this.scopeComposer.compose(ResourceType.Game, Action.read, gameListScope(userId));

    return this.db.$transaction(
      async (tx) => {
        const count = await tx.game.count({ where });

        return sampleByOffsets(count, query.size, gameSummaryReader(tx, where));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * A game the actor may read, with its platform games (#791), its expansions
   * and, for an expansion, its base games (#1069).
   *
   * Each relation is a read of its own, not a filter in the game's `include`:
   * a deny-all condition is dropped there, so a key with no
   * `read:platform_game` would get every platform game, and a link would name
   * a game the actor may not open. They run only once the actor has been
   * allowed to read the game, which is what protects a private game's
   * platform games, and outside the game read's `try`, so a failure of one is
   * never reported as a 404 or 403 of the game.
   */
  async getGame(id: string): Promise<GameDetailDto> {
    const game = await this.readGame(id);
    const linkedGameWhere = this.linkedGameWhere();

    const [platformGames, expansionRows, baseGameRows] = await Promise.all([
      this.db.platformGame.findMany({
        where: this.scopeComposer.compose(ResourceType.PlatformGame, Action.read, { gameId: id }),
        select: PLATFORM_GAME_DETAIL_SELECT,
        orderBy: { platform: { name: 'asc' } },
      }),

      this.db.gameExpansion.findMany({
        where: { baseGameId: id, expansionGame: { is: linkedGameWhere } },
        select: { isStandalone: true, expansionGame: { select: LINKED_GAME_SELECT } },
        orderBy: [{ expansionGame: { title: 'asc' } }, { expansionGameId: 'asc' }],
      }),

      this.db.gameExpansion.findMany({
        where: { expansionGameId: id, baseGame: { is: linkedGameWhere } },
        select: { isStandalone: true, baseGame: { select: LINKED_GAME_SELECT } },
        orderBy: [{ baseGame: { title: 'asc' } }, { baseGameId: 'asc' }],
      }),
    ]);

    const platformIds = await this.readPlatformIds(expansionRows.map(({ expansionGame }) => expansionGame.id));

    return {
      ...game,
      platformGames,
      expansions: expansionRows.map(({ isStandalone, expansionGame }) => ({
        gameId: expansionGame.id,
        isStandalone,
        game: expansionGame,
        platformIds: platformIds.get(expansionGame.id) ?? [],
      })),
      baseGames: baseGameRows.map(({ isStandalone, baseGame }) => ({
        gameId: baseGame.id,
        isStandalone,
        game: baseGame,
      })),
    };
  }

  /**
   * The games a link on `GET /games/:id` may name: the live games the actor
   * could open by id, the ceiling over `deletedAt: null` (#1069). `GET /games`
   * names fewer, those in its intrinsic scope under the ceiling, but that
   * scope needs a user, and this route also serves plugin, system and
   * external actors.
   *
   * The scope is the liveness test alone. Every user role's read rules carry
   * it already, but staff read every game unconditioned, so the ceiling alone
   * would show them a soft-deleted expansion as one to get, which `GET /games`
   * never lists.
   */
  private linkedGameWhere(): Prisma.GameWhereInput {
    return this.scopeComposer.compose(ResourceType.Game, Action.read, { deletedAt: null });
  }

  /**
   * The platforms each of `gameIds` has a platform game on, in platform name
   * order, through the platform game ceiling (#1069). Empty for an API key
   * with no `read:platform_game`, as its platform games are (#791).
   */
  private async readPlatformIds(gameIds: readonly string[]): Promise<ReadonlyMap<string, string[]>> {
    const byGame = new Map<string, string[]>();
    if (gameIds.length === 0) {
      return byGame;
    }

    const rows = await this.db.platformGame.findMany({
      where: this.scopeComposer.compose(ResourceType.PlatformGame, Action.read, { gameId: { in: [...gameIds] } }),
      select: { gameId: true, platformId: true },
      orderBy: { platform: { name: 'asc' } },
    });

    for (const { gameId, platformId } of rows) {
      const forGame = byGame.get(gameId) ?? [];
      forGame.push(platformId);
      byGame.set(gameId, forGame);
    }

    return byGame;
  }

  /**
   * A game's DataGateway links, ordered by DataGateway, then external ID, for
   * asking its DataGateways about it (#1067). The game is read under the same
   * `Game` read conditions as `GET /games/:id`, with the same 404/403 split,
   * so an actor never learns the DataGateway links of a game they can't open.
   */
  async readDataGatewayLinks(id: string): Promise<DataGatewayLink[]> {
    try {
      const { gameSources } = await this.db.game.findUniqueOrThrow({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.read),
        },

        select: {
          gameSources: {
            select: { gatewayId: true, externalId: true },
            orderBy: [{ gatewayId: 'asc' }, { externalId: 'asc' }],
          },
        },
      });

      return gameSources;
    } catch (error) {
      return this.refuseGameRead(id, error);
    }
  }

  private async readGame(id: string) {
    try {
      return await this.db.game.findUniqueOrThrow({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.read),
        },

        include: GAME_DETAIL_INCLUDE,
      });
    } catch (error) {
      return this.refuseGameRead(id, error);
    }
  }

  /**
   * The failure of a read of one game by id, as `GET /games/:id` answers it:
   * 404 when no game has the id, 403 when one does but the actor may not
   * read it. Any other error is rethrown.
   */
  private async refuseGameRead(id: string, error: unknown): Promise<never> {
    this.logger.error(`Error fetching game with id ${id}`, error);
    // findUniqueOrThrow throws P2025 both when no game has this id AND when a
    // game exists but the read conditions exclude it. Only on this error path
    // do we spend a permission-agnostic count to tell 404 from 403 — the
    // happy path stays a single round trip.
    if (isPrismaDependentRecordNotFoundError(error)) {
      const exists = await this.db.game.count({ where: { id } });
      if (exists === 0) {
        throw new NotFoundException(t('errors.game.not_found', { id }));
      }

      throw new ForbiddenException(t('common.forbidden.view'));
    }

    throw error;
  }

  async createGame(createGameDto: CreateGameDto) {
    const userId = this.abilityService.getActingUserId();
    const description = this.sanitizedDescription(createGameDto.description);

    try {
      const game = await this.db.game.create({
        data: {
          ...createGameDto,
          description,

          createdBy: {
            connect: {
              id: userId,
            },
          },
        },
      });

      // Creator gains create-derived grants (createdById-scoped); evict their
      // cached ability graph so those resolve on their next request.
      await this.permissions.invalidateUser(userId);

      return game;
    } catch (error) {
      this.logger.error(`Error creating game`, error);
      throw error;
    }
  }

  async updateGame(id: string, updateGameDto: UpdateGameDto) {
    if (Object.keys(updateGameDto).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const userId = this.abilityService.getActingUserId();
    // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
    const updateConditions = this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.update);

    try {
      // Read through the update conditions, so a caller who may not change the
      // game hears 403 whatever fields they sent, before the rule below can
      // answer 400. The write binds the same conditions again.
      const existing = await this.db.game.findFirst({
        where: { id, AND: updateConditions },
        select: {
          description: true,
          minPlayers: true,
          maxPlayers: true,
          minPlayTime: true,
          maxPlayTime: true,
          createdBy: { select: { isServiceAccount: true } },
        },
      });
      if (existing === null) {
        const exists = await this.db.game.count({ where: { id } });
        if (exists === 0) {
          throw new NotFoundException(t('errors.game.not_found', { id }));
        }

        throw new ForbiddenException(t('common.forbidden.update'));
      }

      // Only an import gives the service account a game, and imported games are
      // public. Re-import never rewrites reach, so one narrowed here, to
      // FriendsOfFriends, Friends or Private, would stay narrowed for good.
      const privatizes = updateGameDto.reach !== undefined && updateGameDto.reach !== Reach.Public;
      if (privatizes && existing.createdBy?.isServiceAccount === true) {
        throw new BadRequestException(t('errors.game.server_owned_stays_public', { id }));
      }

      this.assertRangesInOrder(existing, updateGameDto);

      // The description the game already has is left as it is. An import may
      // have stored one longer than the cap, and it's Markdown the server
      // wrote, which needs no sanitizing again.
      const description =
        updateGameDto.description === existing.description
          ? undefined
          : this.sanitizedDescription(updateGameDto.description);

      const game = await this.db.game.update({
        where: {
          id,
          AND: updateConditions,
        },
        data: {
          ...updateGameDto,
          description,
          updatedById: userId,
        },
      });

      // Updater may gain update-derived grants; evict their cached graph.
      await this.permissions.invalidateUser(userId);

      return game;
    } catch (error) {
      this.logger.error(`Error updating game with id ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }

  async deleteGame(id: string) {
    try {
      const existing = await this.db.game.count({ where: { id } });
      if (existing === 0) {
        throw new NotFoundException(t('errors.game.not_found', { id }));
      }

      // Tombstoned (removed) collection entries don't block deletion — only
      // copies users still own do.
      const collectionsCount = await this.db.gameCollection.count({
        where: {
          deletedAt: null,
          platformGame: {
            gameId: id,
          },
        },
      });
      if (collectionsCount > 0) {
        throw new BadRequestException(t('errors.game.cannot_delete_in_collection'));
      }

      return await this.db.game.delete({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row delete by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.delete),
        },
      });
    } catch (error) {
      this.logger.error(`Error deleting game with id ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.delete'));
      }

      throw error;
    }
  }

  /**
   * Refuses an update that would leave a range's minimum above its maximum.
   * The DTO checks a range sent whole, but a PATCH may send one end alone,
   * and that end has to be held to the one already stored (#869). A field
   * left out keeps its stored value; one sent as null clears it, and a range
   * with an end unknown can't be out of order.
   */
  private assertRangesInOrder(
    existing: Partial<Record<GameRangeField, number | null>>,
    updateGameDto: UpdateGameDto,
  ): void {
    const after = (field: GameRangeField) =>
      (updateGameDto[field] !== undefined ? updateGameDto[field] : existing[field]) ?? null;

    for (const [minField, maxField] of GAME_RANGES) {
      const min = after(minField);
      const max = after(maxField);

      if (min !== null && max !== null && max < min) {
        throw new BadRequestException(t('errors.game.range_reversed', { minField, min, maxField, max }));
      }
    }
  }

  /**
   * A new or changed description as the game stores it: Markdown with
   * nothing unsafe in it, as an imported one is (#714). One longer than
   * {@link GAME_DESCRIPTION_MAX_LENGTH} is refused before it's parsed.
   */
  private sanitizedDescription<T extends null | undefined>(description: string | T): string | T {
    if (typeof description === 'string' && description.length > GAME_DESCRIPTION_MAX_LENGTH) {
      throw new BadRequestException(t('errors.game.description_too_long', { max: GAME_DESCRIPTION_MAX_LENGTH }));
    }

    return sanitizeMarkdown(description);
  }
}
