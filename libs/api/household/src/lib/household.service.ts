import { Action, DatabaseService, InviteStatus, Prisma, ResourceType, SystemRole } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaError } from '@status/codes';
import assert from 'node:assert';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';

@Injectable()
export class HouseholdService {
  private readonly logger = new Logger(HouseholdService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
  ) {}

  async getHouseholdById(id: string) {
    const household = await this.db.household.findUnique({
      where: {
        id,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
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
   */
  private async getSelectMemberGames(memberId: string, excludedCollectionIds: string[]) {
    // Sample the 5 collection ids DB-side (ORDER BY random() LIMIT 5) rather
    // than loading every owned row — with full game descriptions — into memory
    // just to shuffle and slice. random() is also a uniform sample, unlike the
    // former `sort(() => 0.5 - Math.random())`, which is biased and O(n log n).
    const exclusion =
      excludedCollectionIds.length > 0
        ? Prisma.sql`AND id NOT IN (${Prisma.join(excludedCollectionIds)})`
        : Prisma.empty;

    const sampled = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM game_collections
      WHERE user_id = ${memberId}
        AND deleted_at IS NULL
        ${exclusion}
      ORDER BY random()
      LIMIT 5
    `);

    const sampledIds = sampled.map((row) => row.id);
    if (sampledIds.length === 0) {
      return { gameCollections: [], memberId };
    }

    // Fetch the rich shape for only the sampled rows (order is irrelevant for a
    // random sample, so `id IN (...)` is fine).
    const gameCollections = await this.db.gameCollection.findMany({
      where: { id: { in: sampledIds } },
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

    return {
      gameCollections,
      memberId,
    };
  }

  async create(createHouseholdDto: CreateHouseholdDto) {
    const userId = this.abilityService.getActingUserId();
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

        createdBy: {
          connect: {
            id: userId,
          },
        },

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

  async updateHousehold(id: string, updateHouseholdDto: UpdateHouseholdDto) {
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
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.update),
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

  async getHouseholdsForUser(pagination: PaginationQueryDto) {
    return this.db.household.findMany({
      where: {
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
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
   */
  async deleteHousehold(id: string) {
    try {
      const count = await this.db.household.count({ where: { id } });
      assert(count > 0, new NotFoundException(`Household with id ${id} not found`));

      return await this.db.household.delete({
        where: {
          id,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.delete),
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
}
