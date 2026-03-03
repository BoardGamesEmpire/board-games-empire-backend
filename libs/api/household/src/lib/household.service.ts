import { DatabaseService, Household, InviteStatus, SystemRole } from '@bge/database';
import { AppAbility } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { accessibleBy, WhereInput } from '@casl/prisma';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';

@Injectable()
export class HouseholdService {
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
          select: {
            userId: true,
            householdId: true,
            showAllGames: true,
          },

          include: {
            user: {
              select: {
                id: true,
                username: true,
              },
            },

            role: {
              select: {
                id: true,
                householdMemberId: true,
                roleId: true,
              },

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
      {} as Record<string, { id: string; game: { id: string; title: string } }[]>,
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
        game: {
          select: {
            id: true,
            title: true,
            thumbnail: true,
            description: true,
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
    return this.db.household.update({
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
      take: pagination.limit,
    });
  }

  /**
   * @todo soft delete?
   *
   * @param id
   * @returns
   */
  async deleteHousehold(id: string, userAbility: AppAbility, apiKeyAbility?: AppAbility) {
    return this.db.household.delete({
      where: {
        id,
        AND: this.createHouseholdWhereAnd(userAbility, apiKeyAbility),
      },
    });
  }

  private createHouseholdWhereAnd(userAbility: AppAbility, apiKeyAbility?: AppAbility): WhereInput<Household>[] {
    const whereAnd: WhereInput<Household>[] = [];
    if (userAbility) {
      whereAnd.push(accessibleBy(userAbility).Household);
    }
    if (apiKeyAbility) {
      whereAnd.push(accessibleBy(apiKeyAbility).Household);
    }
    return whereAnd;
  }
}
