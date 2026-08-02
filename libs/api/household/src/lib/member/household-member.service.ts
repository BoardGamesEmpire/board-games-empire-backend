import { Action, DatabaseService, Prisma, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { assertHouseholdExists } from '../household-access.helpers';

/**
 * Include object for member queries, so consistent user/profile/role data is
 * always fetched (the household analog of the event `ATTENDEE_INCLUDE`).
 *
 * Intentionally lean: `excludedFromHouseholds` and the sampled game-collection
 * shaping remain `HouseholdService.getHouseholdById` presentation concerns and
 * are NOT part of the roster surface (#155).
 */
export const MEMBER_INCLUDE = {
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
        select: { id: true, name: true },
      },
    },
  },
} as const satisfies Prisma.HouseholdMemberInclude;

export type HouseholdMemberWithRelations = Prisma.HouseholdMemberGetPayload<{ include: typeof MEMBER_INCLUDE }>;

@Injectable()
export class HouseholdMemberService {
  private readonly logger = new Logger(HouseholdMemberService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
  ) {}

  /**
   * Paginated member roster, row-scoped by the actor's `read` conditions on
   * `HouseholdMember` (membership grant OR friends-visibility grant).
   *
   * A missing or soft-deleted household is a 404. An empty scoped page is
   * resolved by {@link isHiddenFromActor}: rows the actor cannot see mean a
   * permission miss (403); no rows at all — or a page past the end — is an
   * honest empty result (200).
   */
  async getMembers(householdId: string, pagination: PaginationQueryDto): Promise<HouseholdMemberWithRelations[]> {
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      householdId,
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.read),
    } satisfies Prisma.HouseholdMemberWhereInput;

    const members = await this.db.householdMember.findMany({
      where: scopedWhere,
      include: MEMBER_INCLUDE,
      orderBy: { createdAt: 'asc' },
      skip: pagination.offset,
      take: pagination.limit || 10,
    });

    if (members.length === 0 && (await this.isHiddenFromActor(scopedWhere, { householdId }))) {
      throw new ForbiddenException(t('common.forbidden.view'));
    }

    this.logger.debug(
      `getMembers(${householdId}) → ${members.length} rows (offset ${pagination.offset}, limit ${pagination.limit})`,
    );

    return members;
  }

  /**
   * Single member by `HouseholdMember.id`, row-scoped like the list. A scoped
   * miss is a hidden row (403) when the row exists unscoped, otherwise a 404.
   */
  async getMember(householdId: string, memberId: string): Promise<HouseholdMemberWithRelations> {
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      id: memberId,
      householdId,
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.read),
    } satisfies Prisma.HouseholdMemberWhereInput;

    const member = await this.db.householdMember.findUnique({
      where: scopedWhere,
      include: MEMBER_INCLUDE,
    });

    if (member) {
      return member;
    }

    if (await this.isHiddenFromActor(scopedWhere, { id: memberId, householdId })) {
      throw new ForbiddenException(t('common.forbidden.view'));
    }

    throw new NotFoundException(t('errors.household.member_not_found', { memberId, householdId }));
  }

  /**
   * Single disambiguation primitive for both read paths: given a scoped query
   * that produced nothing, decide whether that is a permission miss or an
   * honest absence.
   *
   * Returns `true` only when rows matching `unscopedWhere` exist but none are
   * visible under `scopedWhere` — the actor is being denied, not merely looking
   * at an empty set. Deliberately makes NO assumption about a household always
   * having at least one member: that invariant is upheld today only by the
   * absence of a removal endpoint, and #157 (remove member / leave household) is
   * exactly where it would come under pressure. Comparing scoped against
   * unscoped is exact either way.
   *
   * The unscoped count runs only when the scoped count is zero, so an authorized
   * reader paging past the end never triggers the second query.
   */
  private async isHiddenFromActor(
    scopedWhere: Prisma.HouseholdMemberWhereInput,
    unscopedWhere: Prisma.HouseholdMemberWhereInput,
  ): Promise<boolean> {
    const visible = await this.db.householdMember.count({ where: scopedWhere });
    if (visible > 0) {
      // Rows are visible to the actor; the empty result is a page past the end.
      return false;
    }

    return (await this.db.householdMember.count({ where: unscopedWhere })) > 0;
  }
}
