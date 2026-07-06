import { Action, DatabaseService, isPrismaDependentRecordNotFoundError, Prisma, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaError } from '@status/codes';
import assert from 'node:assert';
import { CreateGameDto, UpdateGameDto } from './dto';

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
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
      const existing = await this.db.game.count({ where: { id } });
      assert(existing > 0, new NotFoundException(`Game with ID ${id} not found`));

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
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException("You don't have permission to view this resource.");
      }

      throw error;
    }
  }

  async createGame(createGameDto: CreateGameDto) {
    const userId = this.abilityService.getActingUserId();

    try {
      return await this.db.game.create({
        data: {
          ...createGameDto,

          createdBy: {
            connect: {
              id: userId,
            },
          },
        },
      });
    } catch (error) {
      this.logger.error(`Error creating game`, error);
      throw error;
    }
  }

  async updateGame(id: string, updateGameDto: UpdateGameDto) {
    if (Object.keys(updateGameDto).length === 0) {
      throw new BadRequestException('At least one field must be provided for update');
    }

    try {
      const existing = await this.db.game.count({ where: { id } });
      if (existing === 0) {
        throw new NotFoundException(`Game with ID ${id} not found`);
      }

      return await this.db.game.update({
        where: {
          id,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.update),
        },
        data: {
          ...updateGameDto,
          updatedById: this.abilityService.getActingUserId(),
        },
      });
    } catch (error) {
      this.logger.error(`Error updating game with id ${id}`, error);
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === PrismaError.DependentRecordNotFound) {
          throw new ForbiddenException("You don't have permission to update this resource.");
        }
      }

      throw error;
    }
  }

  async deleteGame(id: string) {
    try {
      const existing = await this.db.game.count({ where: { id } });
      if (existing === 0) {
        throw new NotFoundException(`Game with ID ${id} not found`);
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
        throw new BadRequestException('Cannot delete game that is part of a collection');
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
        throw new ForbiddenException("You don't have permission to delete this resource.");
      }

      throw error;
    }
  }
}
