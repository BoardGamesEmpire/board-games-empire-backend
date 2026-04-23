import { DatabaseService, Household, InviteStatus, Prisma, SystemRole } from '@bge/database';
import { AppAbility } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { accessibleBy, WhereInput } from '@casl/prisma';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaError } from '@status/codes';
import assert from 'node:assert';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';

@Injectable()
export class HouseholdService {
  private readonly logger = new Logger(HouseholdService.name);

  constructor(private readonly db: DatabaseService) {}

  async getHouseholdById(id: string, userAbility: AppAbility, apiKeyAbility?: AppAbility) {
    // consider a raw query instead of this madness

    const household = await this.db.household.findUnique({
      where: {
        id,
        AND: this.createHouseholdWhereAnd(userAbility, apiKeyAbility),
      },
      include: {
        invites: {
          where: {
            AND: [{ status: InviteStatus.Pending }],
          },
        },

        language: {
          select: {
            id: true,
            name: true,
          },
        },

        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                profile: {
                  select: {
                    avatarUrl: true,
                    displayName: true,
                  },
                },
              },
            },

            role: {
              include: {
                role: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },

            excludedFromHouseholds: {
              select: {
                gameCollectionId: true,
              },
            },
          },
        },
      },
    });

    if (!household) {
      throw new NotFoundException(`Household with id ${id} not found`);
    }

    const memberGamesPromises = household.members.map((member) =>
      this.getSelectMemberGames(
        member.userId,
        member.excludedFromHouseholds.map(({ gameCollectionId }) => gameCollectionId),
      ),
    );

    const memberGames = await Promise.all(memberGamesPromises);
    const memberGamesMap = memberGames.reduce(
      (acc, { memberId, gameCollections }) => ({
        ...acc,
        [memberId]: gameCollections,
      }),
      {} as Record<string, { id: string; platformGame: { id: string; game: { id: string; title: string } } }[]>,
    );

    const members = household.members.map((member) => ({
      ...member,
      user: {
        ...member.user,
        gameCollections: memberGamesMap[member.userId] || [],
      },
    }));

    return {
      ...household,
      members,
    };
  }

  /**
   * @todo refine game selection permissions
   *
   * @param memberId
   * @param excludedCollectionIds
   * @returns
   */
  private async getSelectMemberGames(memberId: string, excludedCollectionIds: string[]) {
    const gameCollections = await this.db.gameCollection.findMany({
      where: {
        userId: memberId,
        id: { notIn: excludedCollectionIds },
      },
      select: {
        id: true,
        platformGame: {
          select: {
            id: true,

            game: {
              select: {
                id: true,
                title: true,
                thumbnail: true,
                description: true,
              },
            },
          },
        },
      },
    });

    // Random sample of 5
    const shuffled = gameCollections.sort(() => 0.5 - Math.random());
    const selectGames = shuffled.slice(0, 5);

    // TODO: interfaces
    return {
      gameCollections: selectGames,
      memberId,
    };
  }

  async create(userId: string, createHouseholdDto: CreateHouseholdDto) {
    const { languageId, ...rest } = createHouseholdDto;

    return this.db.household.create({
      data: {
        ...rest,
        language: languageId
          ? {
              connect: {
                id: languageId,
              },
            }
          : undefined,

        members: {
          create: {
            userId,
            role: {
              create: {
                role: {
                  connect: {
                    name: SystemRole.HouseholdOwner,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  async updateHousehold(
    id: string,
    updateHouseholdDto: UpdateHouseholdDto,
    userAbility: AppAbility,
    apiKeyAbility?: AppAbility,
  ) {
    if (Object.keys(updateHouseholdDto).length === 0) {
      throw new BadRequestException('At least one field must be provided for update');
    }

    const { languageId, ...rest } = updateHouseholdDto;

    try {
      const existingHousehold = await this.db.household.count({
        where: {
          id,
        },
      });

      assert(existingHousehold > 0, new NotFoundException(`Household with id ${id} not found or access denied.`));

      return await this.db.household.update({
        where: {
          id,
          AND: this.createHouseholdWhereAnd(userAbility, apiKeyAbility),
        },
        data: {
          ...rest,
          language: languageId
            ? {
                connect: {
                  id: languageId,
                },
              }
            : undefined,
        },
      });
    } catch (error) {
      this.logger.error(`Error updating household with id ${id}`, error);
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === PrismaError.DependentRecordNotFound) {
          throw new ForbiddenException("You don't have permission to update this resource.");
        }
      }

      throw error;
    }
  }

  async getHouseholdsForUser(pagination: PaginationQueryDto, userAbility: AppAbility, apiKeyAbility?: AppAbility) {
    return this.db.household.findMany({
      where: {
        AND: this.createHouseholdWhereAnd(userAbility, apiKeyAbility),
      },

      include: {
        language: {
          select: {
            id: true,
            name: true,
          },
        },

        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                profile: {
                  select: {
                    avatarUrl: true,
                    displayName: true,
                  },
                },
              },
            },

            role: {
              include: {
                role: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },

      skip: pagination.offset,
      take: pagination.limit || 10,
    });
  }

  /**
   * @todo soft delete - also need to consider how this affects invites and game collection sharing
   *
   * @param id
   * @returns
   */
  async deleteHousehold(id: string, userAbility: AppAbility, apiKeyAbility?: AppAbility) {
    try {
      const count = await this.db.household.count({ where: { id } });
      assert(count > 0, new NotFoundException(`Household with id ${id} not found`));

      return await this.db.household.delete({
        where: {
          id,
          AND: this.createHouseholdWhereAnd(userAbility, apiKeyAbility),
        },
      });
    } catch (error) {
      this.logger.error(`Error deleting household with id ${id}`, error);
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === PrismaError.DependentRecordNotFound) {
          throw new NotFoundException(`Household with id ${id} not found`);
        }
      }

      throw error;
    }
  }

  private createHouseholdWhereAnd(userAbility: AppAbility, apiKeyAbility?: AppAbility): WhereInput<Household>[] {
    const whereAnd: WhereInput<Household>[] = [];

    try {
      if (userAbility) {
        whereAnd.push(accessibleBy(userAbility).Household);
      }
      if (apiKeyAbility) {
        whereAnd.push(accessibleBy(apiKeyAbility).Household);
      }
    } catch (error) {
      this.logger.error('Error creating where conditions for household access control', error);
      throw new ForbiddenException("You don't have permission to access this resource.");
    }

    return whereAnd;
  }
}
