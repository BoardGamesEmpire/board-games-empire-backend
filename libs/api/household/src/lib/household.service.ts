import {
  Action,
  DatabaseService,
  InviteStatus,
  isPrismaDependentRecordNotFoundError,
  Prisma,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { t } from '@bge/i18n';
import { canonicalizeTag } from '@bge/locale';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import assert from 'node:assert';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';

@Injectable()
export class HouseholdService {
  private readonly logger = new Logger(HouseholdService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
  ) {}

  async getHouseholdById(id: string) {
    const household = await this.db.household.findUnique({
      where: {
        id,
        deletedAt: null,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
      },
      include: {
        invites: {
          where: {
            AND: [{ status: InviteStatus.Pending }],
          },
        },

        languageTag: {
          select: {
            id: true,
            tag: true,
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
      // The scoped read matched nothing: probe existence to distinguish a
      // missing household (404) from one that exists but isn't visible (403).
      if (await this.householdExists(id)) {
        throw new ForbiddenException(t('common.forbidden.view'));
      }
      throw new NotFoundException(t('errors.household.not_found', { id }));
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

  /**
   * Cheap existence probe (excludes soft-deleted). Lets a caller distinguish a
   * household that does not exist (→ 404) from one that exists but the actor may
   * not read/mutate (→ 403) once a permission-scoped query returns nothing.
   */
  private async householdExists(id: string): Promise<boolean> {
    const count = await this.db.household.count({ where: { id, deletedAt: null } });
    return count > 0;
  }

  /**
   * Resolves a client-supplied BCP 47 tag to the LanguageTag row id.
   * 400 on syntactically invalid tags and on tags outside the vocabulary.
   */
  private async resolveLanguageTagId(tag: string | undefined): Promise<string | undefined> {
    if (tag === undefined) {
      return undefined;
    }

    const canonical = canonicalizeTag(tag);
    assert(canonical, new BadRequestException(t('errors.household.invalid_language_tag', { tag })));

    const languageTag = await this.db.languageTag.findUnique({
      where: { tag: canonical },
      select: { id: true },
    });
    assert(languageTag, new BadRequestException(t('errors.household.language_tag_unsupported', { tag: canonical })));

    return languageTag.id;
  }

  async create(createHouseholdDto: CreateHouseholdDto) {
    const userId = this.abilityService.getActingUserId();
    const { language, ...rest } = createHouseholdDto;
    const languageTagId = await this.resolveLanguageTagId(language);

    const household = await this.db.household.create({
      data: {
        ...rest,
        languageTag: languageTagId
          ? {
              connect: {
                id: languageTagId,
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

    // The acting user just became a HouseholdOwner — evict their cached ability
    // graph so the new household-scoped grants resolve on their next request.
    await this.permissions.invalidateUser(userId);

    return household;
  }

  async updateHousehold(id: string, updateHouseholdDto: UpdateHouseholdDto) {
    if (Object.keys(updateHouseholdDto).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const { language, ...rest } = updateHouseholdDto;
    const languageTagId = await this.resolveLanguageTagId(language);

    try {
      // Existence first (→ 404); the scoped update below enforces permission
      // (P2025 → 403). Keeps the two outcomes distinguishable.
      assert(await this.householdExists(id), new NotFoundException(t('errors.household.not_found', { id })));

      return await this.db.household.update({
        where: {
          id,
          deletedAt: null,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.update),
        },
        data: {
          ...rest,
          languageTag: languageTagId
            ? {
                connect: {
                  id: languageTagId,
                },
              }
            : undefined,
        },
      });
    } catch (error) {
      this.logger.error(`Error updating household with id ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }

  async getHouseholdsForUser(pagination: PaginationQueryDto) {
    return this.db.household.findMany({
      where: {
        deletedAt: null,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
      },

      include: {
        languageTag: {
          select: {
            id: true,
            tag: true,
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
   * Soft-delete: the row is retained (`deletedAt` stamped) and hidden from every
   * read (`getHouseholdById`/`getHouseholdsForUser`/`updateHousehold` all filter
   * `deletedAt: null`). Outstanding invites to the household are revoked in the
   * same transaction so a stale token can never be accepted into a dead
   * household. Members and game-collection shares are intentionally left in place
   * — a soft delete is reversible and reads already exclude the household; hard
   * cascade/cleanup is deferred to the (future) purge path.
   */
  async deleteHousehold(id: string) {
    try {
      // Existence first (→ 404); the scoped update below enforces the delete
      // policy (owner-only), and a non-matching `where` (→ P2025) maps to 403 —
      // consistent with updateHousehold and GameService.delete/update.
      assert(await this.householdExists(id), new NotFoundException(t('errors.household.not_found', { id })));

      const { household, memberUserIds } = await this.db.$transaction(async (tx) => {
        const household = await tx.household.update({
          where: {
            id,
            deletedAt: null,
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.delete),
          },
          data: { deletedAt: new Date() },
        });

        // Outstanding invites to a dead household can never be accepted.
        await tx.invite.updateMany({
          where: {
            householdId: id,
            status: { in: [InviteStatus.Pending, InviteStatus.AwaitingApproval] },
          },
          data: { status: InviteStatus.Revoked },
        });

        // Member rows survive the soft delete; capture them so their cached
        // ability graphs can be evicted (the household just left their surface).
        const members = await tx.householdMember.findMany({
          where: { householdId: id },
          select: { userId: true },
        });

        return { household, memberUserIds: members.map((member) => member.userId) };
      });

      // Evict every member's graph so stale Household* abilities don't linger for
      // the cache TTL. The graph query also excludes soft-deleted memberships, so
      // the rebuild omits this household even before the eviction lands.
      await this.permissions.invalidateUsers(memberUserIds);

      return household;
    } catch (error) {
      this.logger.error(`Error deleting household with id ${id}`, error);
      // Existence was confirmed above, so a scoped-update miss means the actor
      // isn't permitted to delete this household (owner-only) → 403.
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.delete'));
      }

      throw error;
    }
  }
}
