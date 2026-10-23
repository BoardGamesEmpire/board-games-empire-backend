import {
  Action,
  DatabaseService,
  HUMAN_USER_WHERE,
  isPrismaDependentRecordNotFoundError,
  Prisma,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { InviteService } from '@bge/invites';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateHouseholdBanDto, UpdateHouseholdBanDto } from '../dto';
import { lockExistingHousehold, lockHouseholdForRoleTransition } from '../household-access.helpers';
import { ROSTER_ROLE_SELECT } from '../invite/household-authority';
import { HouseholdMemberService } from '../member/household-member.service';
import { isBannedWithin } from './household-ban.helpers';
import { HOUSEHOLD_BAN_SELECT, toHouseholdBanView, type HouseholdBanView } from './household-ban.read-shape';

/** The ban routes' actions on a household's bans. */
type BanAction = typeof Action.create | typeof Action.read | typeof Action.update | typeof Action.delete;

/**
 * Bans a user from a household, changes a ban's reason, lifts a ban, and
 * lists a household's bans (#782). A ban is the household's lasting refusal:
 * the invite create and the admission read it (`household-ban.helpers.ts`).
 * Nobody is told of a ban, the banned user included.
 */
@Injectable()
export class HouseholdBanService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
    private readonly permissions: PermissionsService,
    private readonly invites: InviteService,
    private readonly members: HouseholdMemberService,
  ) {}

  /**
   * Bans a user from the household, in one transaction:
   *
   * 1. Banning yourself is refused with 400, before anything is read.
   * 2. The caller must hold `create` on a ban from THIS household, asked of
   *    the roster before the lock, so a caller with no say here is refused
   *    without holding the household's row.
   * 3. The household row is locked for a role transition. Removing a member
   *    takes the same lock, and an admission's share lock waits on it, so an accept
   *    queued behind the ban finds its invite revoked.
   * 4. The question is asked again of the roster read under the lock, and
   *    that answer decides.
   * 5. The user must exist and be a registered user: 404 otherwise. A user already
   *    banned is 409; the lock serializes two bans of the same user.
   * 6. A member is removed, under the caller's own `manage` scope on the
   *    member: a household admin who may not remove a household admin or an
   *    owner may not ban one either (403), and the last owner is refused
   *    (400). Leaving's revokes come with it (#747). A non-member's invites
   *    are revoked the same way: those that name them by id, and those they
   *    sent.
   * 7. The open invites to their address are withheld, never revoked, so no
   *    inviter learns whose address it was.
   * 8. The ban is recorded.
   *
   * After commit a removed member's ability cache is evicted, and then the
   * revoked invites are announced. A refusal at any step writes nothing.
   */
  async ban(householdId: string, dto: CreateHouseholdBanDto): Promise<HouseholdBanView> {
    const bannerId = this.abilityService.getActingUserId();

    if (dto.userId === bannerId) {
      throw new BadRequestException(t('errors.household.ban_self'));
    }

    const { ban, wasMember, revoked } = await this.db.$transaction(async (tx) => {
      await this.assertBanAuthority(tx, householdId, Action.create);
      await lockHouseholdForRoleTransition(tx, householdId);
      await this.assertBanAuthority(tx, householdId, Action.create);

      const target = await tx.user.findUnique({
        where: { id: dto.userId, ...HUMAN_USER_WHERE },
        select: { id: true, email: true },
      });

      if (!target) {
        throw new NotFoundException(t('errors.user.not_found', { id: dto.userId }));
      }

      if (await isBannedWithin(tx, householdId, target.id)) {
        throw new ConflictException(t('errors.household.already_banned', { householdId }));
      }

      const removed = await this.members.removeUserWithin(tx, householdId, target.id);
      const revoked =
        removed?.revoked ?? (await this.invites.revokeOutstandingOfUserWithin(tx, { householdId }, target.id)).events;

      await this.invites.withholdOutstandingToAddressWithin(tx, { householdId }, target.email);

      const ban = await tx.householdBan.create({
        data: { householdId, userId: target.id, bannedById: bannerId, reason: dto.reason ?? null },
        select: HOUSEHOLD_BAN_SELECT,
      });

      return { ban, wasMember: removed !== null, revoked };
    });

    // The household just left a removed member's ability surface.
    if (wasMember) {
      await this.permissions.invalidateUser(ban.user.id);
    }

    this.invites.emit(revoked);

    return toHouseholdBanView(ban);
  }

  /**
   * Sets, replaces or clears a ban's reason (`null` clears it), asked of the
   * roster before and after the household's share lock, so a demotion that
   * lands first is seen. 404 when the user isn't banned.
   */
  async updateReason(householdId: string, userId: string, dto: UpdateHouseholdBanDto): Promise<HouseholdBanView> {
    const ban = await this.db.$transaction(async (tx) => {
      await this.findBanAsAuthority(tx, householdId, userId, Action.update);

      return this.writeToBan(householdId, userId, () =>
        tx.householdBan.update({
          where: { householdId_userId: { householdId, userId } },
          data: { reason: dto.reason },
          select: HOUSEHOLD_BAN_SELECT,
        }),
      );
    });

    return toHouseholdBanView(ban);
  }

  /**
   * Lifts a ban, asked as {@link updateReason} asks, and hands it back as it
   * was. The user may be invited by id again. Invites to their address that
   * the ban withheld stay withheld: lifting the ban doesn't send them.
   */
  async lift(householdId: string, userId: string): Promise<HouseholdBanView> {
    const ban = await this.db.$transaction(async (tx) => {
      const existing = await this.findBanAsAuthority(tx, householdId, userId, Action.delete);

      await this.writeToBan(householdId, userId, () => tx.householdBan.delete({ where: { id: existing.id } }));

      return existing;
    });

    return toHouseholdBanView(ban);
  }

  /**
   * One page of the household's bans, newest first. The caller must hold
   * `read` on this household's bans, asked of the instance: the route's
   * type-only check passes an owner or admin of SOME household. The rows then
   * compose under the same grant.
   *
   * REPEATABLE READ, so `total` and the rows come from one snapshot (#230).
   * `id` breaks ties on `createdAt`, so a row cannot cross a page boundary
   * between two requests.
   */
  async list(householdId: string, query: PaginationQueryDto): Promise<PaginatedRows<HouseholdBanView>> {
    await this.assertBanAuthority(this.db, householdId, Action.read);

    const where = this.scopeComposer.compose(ResourceType.HouseholdBan, Action.read, { householdId });

    const [rows, total] = await this.db.$transaction(
      [
        this.db.householdBan.findMany({
          where,
          select: HOUSEHOLD_BAN_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: query.skip,
          take: query.pageSize,
        }),

        this.db.householdBan.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: rows.map(toHouseholdBanView), total };
  }

  /**
   * The ban an update or a lift acts on: `action` asked of the roster before
   * and after the household's share lock, then the ban read. 404 when the
   * user isn't banned.
   */
  private async findBanAsAuthority(
    tx: Prisma.TransactionClient,
    householdId: string,
    userId: string,
    action: typeof Action.update | typeof Action.delete,
  ) {
    await this.assertBanAuthority(tx, householdId, action);
    await lockExistingHousehold(tx, householdId);
    await this.assertBanAuthority(tx, householdId, action);

    const ban = await tx.householdBan.findUnique({
      where: { householdId_userId: { householdId, userId } },
      select: HOUSEHOLD_BAN_SELECT,
    });

    if (!ban) {
      throw this.banNotFound(householdId, userId);
    }

    return ban;
  }

  /**
   * Runs a write to a ban that was read a moment before. Two lifts sent at
   * once, as a double-click sends them, both find the ban under the
   * household's share lock, and the write that lands second finds it gone. It
   * answers 404, as a read that found it gone does, rather than a 500.
   */
  private async writeToBan<T>(householdId: string, userId: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw this.banNotFound(householdId, userId);
      }

      throw error;
    }
  }

  private banNotFound(householdId: string, userId: string): NotFoundException {
    return new NotFoundException(t('errors.household.ban_not_found', { userId, householdId }));
  }

  /**
   * Asks whether the acting user may `action` a ban from this household, of
   * the household's whole roster as `client` reads it, as the invite routes
   * ask: a roster cut down to the caller's own row would pass a `none` or
   * `every` clause it should refuse.
   */
  private async assertBanAuthority(
    client: DatabaseService | Prisma.TransactionClient,
    householdId: string,
    action: BanAction,
  ): Promise<void> {
    const members = await client.householdMember.findMany({ where: { householdId }, select: ROSTER_ROLE_SELECT });

    this.abilityService.assertCurrentActorCan(action, ResourceType.HouseholdBan, {
      householdId,
      household: { members },
    });
  }
}
