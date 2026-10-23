import { sanitizeMarkdown } from '@bge/content-format';
import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  Prisma,
  Reach,
  ResourceType,
  type Game,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { PaginationQueryDto, type PaginatedRows } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateGameDto, GAME_DESCRIPTION_MAX_LENGTH, UpdateGameDto } from './dto';
import { gameListScope } from './game-list-scope';

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
   * The scope is {@link gameListScope}, the live Public games, the acting
   * user's own, a friend's that reach friends and a friend of a friend's that
   * reach friends of friends (#496), and the ceiling only clips it (#513).
   * For an `apiKey` actor it carries the key ∩ owner floor.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors:
   * half the scope is the caller's own games, which has no meaning without a
   * user, and the refusal must never soften into a page of Public games.
   * PROVISIONAL — #395.
   */
  async getGames(pagination: PaginationQueryDto): Promise<PaginatedRows<Game>> {
    const userId = resolveScopeSubjectId(this.abilityService);
    const where = this.scopeComposer.compose(ResourceType.Game, Action.read, gameListScope(userId));

    const [rows, total] = await this.db.$transaction(
      [
        this.db.game.findMany({
          where,
          // A catalog reads best alphabetically, and `title` is not unique — two
          // editions of the same game share one — so `id` completes the order.
          // Without a total order the database may return page 2 overlapping page 1.
          orderBy: [{ title: 'asc' }, { id: 'asc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.game.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  async getGame(id: string) {
    try {
      return await this.db.game.findUniqueOrThrow({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.read),
        },

        include: {
          artists: {
            select: {
              id: true,
              role: true,
              details: true,

              artist: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },

          categories: {
            select: {
              id: true,
              isPrimary: true,

              category: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },

          designers: {
            select: {
              id: true,
              role: true,

              designer: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },

          families: {
            select: {
              id: true,

              family: {
                select: {
                  id: true,
                  name: true,
                  familyType: true,
                },
              },
            },
          },

          mechanics: {
            select: {
              id: true,

              mechanic: {
                select: {
                  id: true,
                  name: true,
                  description: true,
                  complexity: true,
                },
              },
            },
          },

          publishers: {
            select: {
              id: true,
              role: true,

              publisher: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },

          tags: {
            select: {
              id: true,

              tag: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },

          expansions: {
            select: {
              id: true,
              baseGameId: true,
              expansionGameId: true,
            },
          },
        },
      });
    } catch (error) {
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
        select: { description: true, createdBy: { select: { isServiceAccount: true } } },
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
