import {
  Action,
  DatabaseService,
  gameShareSnapshot,
  householdGameShareSubject,
  Prisma,
  ResourceType,
  type GameShare,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { PaginationQueryDto, type PaginatedRows } from '@bge/shared';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HouseholdGameShareApprovedEvent } from '../events/household.events';
import { assertHouseholdExists, lockExistingHousehold } from '../household-access.helpers';
import { ROSTER_ROLE_SELECT, type RosterRow } from '../invite/household-authority';

/**
 * The column an approval writes, and the one the approve permission is bound
 * to (#810). Naming it keeps any other `update` grant on a share from passing
 * for an approval.
 */
const APPROVE_FIELD = Prisma.GameShareScalarFieldEnum.approvedAt;

/**
 * A share as the household's list reads it (#810): its columns, and the game
 * it is of by id, title and thumbnail, so an approver can tell what they are
 * approving. The game is read through the share, so it is named even to an
 * approver who cannot read the game itself, which a waiting share does not
 * yet show them.
 */
const HOUSEHOLD_SHARE_SELECT = {
  id: true,
  gameId: true,
  userId: true,
  householdId: true,
  sharedById: true,
  approvedById: true,
  approvedAt: true,
  createdAt: true,
  game: { select: { id: true, title: true, thumbnail: true } },
} as const satisfies Prisma.GameShareSelect;

export type HouseholdGameShareView = Prisma.GameShareGetPayload<{ select: typeof HOUSEHOLD_SHARE_SELECT }>;

/**
 * The household's side of its game shares (#810): listing them, and
 * approving a member's share that waits under the `NeedsApproval` member share
 * policy. Sharing a game and removing a share are the game's routes, in
 * `@bge/game`. This service writes `GameShare` through Prisma itself, so the
 * household lib takes no import from the game lib.
 */
@Injectable()
export class HouseholdGameShareService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * One page of the household's shares, waiting and in effect, newest first,
   * as its invites are listed (`HouseholdInviteService.listInvites`).
   *
   * The caller must hold `read` on this household's shares, asked of the
   * instance with the household's roster: the route's type-only check passes
   * every user, who reads the shares of the games they created, so without
   * this a member or a guest would get a page rather than a 403. It is asked
   * before the household's liveness, so only a caller who may read the shares
   * learns that the household is gone. The rows then compose under the same
   * grant, so staff, who read every share, see this household's rows and no
   * other household's.
   *
   * Rows and count share a REPEATABLE READ transaction, so `total` describes
   * the rows served (#230). `id` breaks ties on `createdAt`, so a row cannot
   * cross a page boundary between two requests.
   */
  async listShares(
    householdId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<HouseholdGameShareView>> {
    await this.assertShareAuthority(this.db, householdId, Action.read);
    await assertHouseholdExists(this.db, householdId);

    const where = this.scopeComposer.compose(ResourceType.GameShare, Action.read, { householdId });

    const [rows, total] = await this.db.$transaction(
      [
        this.db.gameShare.findMany({
          where,
          select: HOUSEHOLD_SHARE_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.gameShare.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /**
   * Puts a member's waiting share into the household in effect, in one
   * transaction, in the order an invite's approval takes
   * (`HouseholdInviteService.approveInvite`):
   *
   * 1. The acting user must hold `update` on this share's `approvedAt` in THIS
   *    household, asked of the instance before the lock: the route's type-only
   *    check passes the owner or admin of any household. The instance needs
   *    nothing of the share's row but its id, so it is asked before the share
   *    is read, and only someone who may approve here learns whether the
   *    household has such a share.
   * 2. The household row is share-locked, or the answer is 404 once the
   *    household is gone. A role transition takes the same row
   *    `FOR NO KEY UPDATE`, which conflicts, so no demotion lands between the
   *    answer below and the approval.
   * 3. The question is asked again of the roster read under the lock, and that
   *    answer decides.
   * 4. The write, bound to this household and guarded on `approvedAt` still
   *    being null, with no `limit`, so the guard is rechecked against a
   *    concurrent write: of two approvals at once, the second finds the first's
   *    `approvedAt` and writes nothing.
   * 5. The share is read back from this household: 404 when it has none by
   *    that id, a share its sharer removed included, and 409 when the guard
   *    wrote nothing, since the share is already in effect.
   * 6. Its sharer must still be able to share it, in effect or for approval,
   *    on the roster read under the lock and the member share policy: the
   *    question an invite's approval asks of its sender. If not, the answer is
   *    409 and the rollback undoes the approval, so the share waits on, for an
   *    approver or its sharer to remove.
   *
   * So a share made for approval stays approvable after a switch to `Direct`,
   * which its sharer could still share it under, and not after one to `Off`.
   *
   * The approved share is announced after commit.
   */
  async approve(householdId: string, shareId: string): Promise<GameShare> {
    const approverId = this.abilityService.getActingUserId();
    const now = new Date();

    const { before, after } = await this.db.$transaction(async (tx) => {
      await this.assertShareAuthority(tx, householdId, Action.update, shareId);
      await lockExistingHousehold(tx, householdId);
      const members = await this.assertShareAuthority(tx, householdId, Action.update, shareId);

      const { count } = await tx.gameShare.updateMany({
        where: { id: shareId, householdId, approvedAt: null },
        data: { approvedAt: now, approvedById: approverId },
      });
      const share = await tx.gameShare.findFirst({ where: { id: shareId, householdId } });

      if (share === null) {
        throw new NotFoundException(t('errors.game_share.not_found_in_household', { id: shareId, householdId }));
      }

      if (count === 0) {
        throw new ConflictException(t('errors.game_share.not_awaiting_approval', { id: shareId }));
      }

      if (!(await this.sharerCouldStillShare(tx, householdId, share, members, now))) {
        throw new ConflictException(t('errors.game_share.sharer_cannot_share', { id: shareId }));
      }

      // The guard saw `approvedAt` null, and `approvedById` is only ever
      // written beside it, so both were null before this write.
      return { before: { ...share, approvedAt: null, approvedById: null }, after: share };
    });

    this.eventEmitter.emit(
      HouseholdGameShareApprovedEvent.eventName,
      new HouseholdGameShareApprovedEvent(gameShareSnapshot(before), gameShareSnapshot(after), now),
    );

    return after;
  }

  /**
   * Asks whether the acting user may read the household's shares, or approve
   * the share `shareId` names, of the household's whole roster as `client`
   * reads it, with each member's household role: the condition is written
   * over the roster, so a roster cut down to the caller's own row would pass
   * a `none` or `every` clause it should refuse. A missing household reads as
   * an empty roster, which no household grant matches.
   *
   * An approval names the share's id, so a key scoped to one share is asked
   * about it. An `update` names the column an approval writes, which is all
   * that tells the approve permission from any other `update` grant on a
   * share; a read names no column. The two are keyed apart: the id on
   * `shareId`, the column on the action.
   *
   * Answers the roster it asked about.
   */
  private async assertShareAuthority(
    client: DatabaseService | Prisma.TransactionClient,
    householdId: string,
    action: typeof Action.read | typeof Action.update,
    shareId?: string,
  ): Promise<RosterRow[]> {
    const members = await client.householdMember.findMany({ where: { householdId }, select: ROSTER_ROLE_SELECT });
    const named = shareId === undefined ? {} : { id: shareId };

    this.abilityService.assertCurrentActorCan(
      action,
      ResourceType.GameShare,
      { ...named, householdId, household: { members } },
      action === Action.update ? APPROVE_FIELD : undefined,
    );

    return members;
  }

  /**
   * Whether the share's sharer could share it into the household now, asked
   * of their own ability as `tx` reads it, about `members`, the roster the
   * caller read under its household lock, and the member share policy read
   * here: their role and the policy as they stand now, not as they stood when
   * they shared it, as an invite's approval asks of its sender
   * (`senderCouldStillSend`, #747). So a share whose sharer has been demoted
   * to guest or banned, or whose member share policy has gone to `Off`, is
   * one nobody can approve.
   *
   * A sharer no longer on the roster could share nothing here, as the share's
   * create refuses someone with no seat in the household, and neither could
   * one whose account was deleted, which empties `sharedById`.
   *
   * Either way counts, in effect or for approval. The sharer's graph is
   * loaded once for both questions.
   */
  private async sharerCouldStillShare(
    tx: Prisma.TransactionClient,
    householdId: string,
    share: GameShare,
    members: RosterRow[],
    now: Date,
  ): Promise<boolean> {
    const sharerId = share.sharedById;

    if (sharerId === null || !members.some((member) => member.userId === sharerId)) {
      return false;
    }

    const settings = await tx.householdSettings.findUnique({
      where: { householdId },
      select: { memberSharePolicy: true },
    });
    // A share is deleted with its game, so the share read has one.
    const game = await tx.game.findUniqueOrThrow({
      where: { id: share.gameId },
      select: { deletedAt: true, createdById: true },
    });
    const sharerCan = await this.abilityService.userAbilityWithin(tx, sharerId);

    const couldShare = (approvedAt: Date | null) =>
      sharerCan(
        Action.create,
        ResourceType.GameShare,
        householdGameShareSubject(householdId, approvedAt, game, { members, settings }),
      );

    return couldShare(now) || couldShare(null);
  }
}
