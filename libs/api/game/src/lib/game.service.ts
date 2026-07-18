import { Action, DatabaseService, isPrismaDependentRecordNotFoundError, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateGameDto, UpdateGameDto } from './dto';

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
  ) {}

  async getGames(pagination: PaginationQueryDto) {
    return this.db.game.findMany({
      where: {
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.read),
      },
      skip: pagination.offset,
      take: pagination.limit || 20,
    });
  }

  async getGame(id: string) {
    try {
      return await this.db.game.findUniqueOrThrow({
        where: {
          id,
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

    try {
      const game = await this.db.game.create({
        data: {
          ...createGameDto,

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

    try {
      const existing = await this.db.game.count({ where: { id } });
      if (existing === 0) {
        throw new NotFoundException(t('errors.game.not_found', { id }));
      }

      const game = await this.db.game.update({
        where: {
          id,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.update),
        },
        data: {
          ...updateGameDto,
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
}
