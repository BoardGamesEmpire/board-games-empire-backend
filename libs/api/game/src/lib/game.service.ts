import { DatabaseService, Game, isPrismaDependentRecordNotFoundError, Prisma } from '@bge/database';
import { AppAbility } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { accessibleBy, WhereInput } from '@casl/prisma';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaError } from '@status/codes';
import assert from 'node:assert';
import { CreateGameDto, UpdateGameDto } from './dto';

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);

  constructor(private readonly db: DatabaseService) {}

  async getGames(pagination: PaginationQueryDto, abilities: AppAbility[]) {
    return this.db.game.findMany({
      where: {
        AND: this.createGameWhereAnd(abilities),
      },
      skip: pagination.offset,
      take: pagination.limit,
    });
  }

  async getGame(id: string, abilities: AppAbility[]) {
    try {
      const existing = await this.db.game.count({ where: { id } });
      assert(existing > 0, new NotFoundException(`Game with ID ${id} not found`));

      return await this.db.game.findUniqueOrThrow({
        where: {
          id,
          AND: this.createGameWhereAnd(abilities),
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
      this.logger.error(`Error updating game with id ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException("You don't have permission to update this resource.");
      }

      throw error;
    }
  }

  async createGame(userId: string, createGameDto: CreateGameDto) {
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

  async updateGame(id: string, updateGameDto: UpdateGameDto, abilities: AppAbility[]) {
    assert(
      Object.keys(updateGameDto).length > 0,
      new BadRequestException('At least one field must be provided for update'),
    );

    try {
      const existing = await this.db.game.count({ where: { id } });
      assert(existing > 0, new NotFoundException(`Game with ID ${id} not found`));

      return await this.db.game.update({
        where: {
          id,
          AND: this.createGameWhereAnd(abilities),
        },
        data: {
          ...updateGameDto,
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

  async deleteGame(id: string, abilities: AppAbility[]) {
    try {
      const existing = await this.db.game.count({ where: { id } });
      assert(existing > 0, new NotFoundException(`Game with ID ${id} not found`));

      const collectionsCount = await this.db.gameCollection.count({
        where: {
          game: {
            id,
          },
        },
      });

      assert(collectionsCount === 0, new BadRequestException('Cannot delete game that is part of a collection'));

      return await this.db.game.delete({
        where: {
          id,
          AND: this.createGameWhereAnd(abilities),
        },
      });
    } catch (error) {
      this.logger.error(`Error deleting game with id ${id}`, error);
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === PrismaError.DependentRecordNotFound) {
          throw new ForbiddenException("You don't have permission to delete this resource.");
        }
      }

      throw error;
    }
  }

  private createGameWhereAnd(abilities: AppAbility[]): WhereInput<Game>[] {
    const whereAnd: WhereInput<Game>[] = [];

    try {
      for (const ability of abilities) {
        if (ability) {
          whereAnd.push(accessibleBy(ability).Game);
        }
      }
    } catch (error) {
      this.logger.error('Error creating where conditions for game access control', error);
      throw new ForbiddenException("You don't have permission to access this resource.");
    }

    return whereAnd;
  }
}
