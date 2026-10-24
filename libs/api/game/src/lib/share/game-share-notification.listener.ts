import { DatabaseService, NotificationType, Prisma, SystemRole, type GameShareSnapshot } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { GameShareEvents, type GameShareCreatedEvent } from './game-share.events';

/**
 * What the sharer's name is read from. The household lib's `shownName` rule,
 * copied rather than imported: this lib takes no import from `@bge/household`.
 */
const SHARER_NAME_SELECT = {
  username: true,
  profile: { select: { displayName: true } },
} as const satisfies Prisma.UserSelect;

/**
 * What a notification of a share reads off the stored share, beside the event:
 * whether the share still stands and waits, and the game, the sharer and the
 * household it names.
 */
const SHARE_NOTICE_SELECT = {
  approvedAt: true,
  game: { select: { title: true, deletedAt: true } },
  sharedBy: { select: SHARER_NAME_SELECT },
  household: { select: { name: true, deletedAt: true } },
} as const satisfies Prisma.GameShareSelect;

/**
 * The household members who answer for what the household shares: its owners
 * and admins, by their role in its own roster (#810). The household lib's
 * invite notifications go to the same two roles.
 */
const HOUSEHOLD_AUTHORITY_ROLES: readonly SystemRole[] = [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin];

/** A stored share whose game and sharer still exist, as a notification names it. */
interface LiveShare {
  readonly gameTitle: string;
  readonly sharerName: string;
  /**
   * The household the share is into, while it is not deleted. Null means
   * either a share to a user or a household that is gone, so only
   * `notifyApprovers`, which is only reached for a household share, may read
   * it as gone.
   */
  readonly household: { readonly name: string } | null;
  readonly approvedAt: Date | null;
}

/**
 * Tells people about game shares (#810): a user a share names, and the
 * household owners and admins of a member's share that waits for their
 * approval. A household share that takes effect on create tells nobody, and
 * the members of a household are never told: notifying all of them of every
 * game shared in would be noise, and they find a share among the games they
 * can read.
 *
 * The event is emitted after its transaction commits, so the request has
 * already answered. The handler therefore never throws: it logs its own
 * failure and resolves, and the notification is lost rather than the share it
 * reports.
 */
@Injectable()
export class GameShareNotificationListener {
  private readonly logger = new Logger(GameShareNotificationListener.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * A share to a user always takes effect on create, so the user is told now.
   * A share to a household is told of only while it waits: the household's
   * owners and admins hear that it needs them. One that takes effect on create
   * is the household's to find, and tells no one.
   */
  @OnEvent(GameShareEvents.Created, { async: true })
  async onShareCreated(event: GameShareCreatedEvent): Promise<void> {
    const share = event.after;

    try {
      if (share.userId !== null) {
        await this.notifyRecipient(share, share.userId);
      } else if (share.householdId !== null && share.approvedAt === null) {
        await this.notifyApprovers(share, share.householdId);
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify on GameShareCreated shareId=${share.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Tells the user a game was shared with them, naming the game and who shared it. */
  private async notifyRecipient(share: GameShareSnapshot, userId: string): Promise<void> {
    const live = await this.liveShare(share);

    if (!live) {
      return;
    }

    await this.notifications.create({
      userId,
      type: NotificationType.GameShareReceived,
      payload: { shareId: share.id, gameId: share.gameId, gameTitle: live.gameTitle, sharerName: live.sharerName },
    });
  }

  /**
   * Tells the household owners and admins that a share waits for their
   * approval, all but the sharer, who knows. A share approved between the emit
   * and the handler tells no one: it no longer waits.
   */
  private async notifyApprovers(share: GameShareSnapshot, householdId: string): Promise<void> {
    const live = await this.liveShare(share);

    if (!live) {
      return;
    }

    if (live.approvedAt !== null) {
      return this.logger.debug(`Share already approved, skipping GameShareAwaitingApproval shareId=${share.id}`);
    }

    if (live.household === null) {
      return this.logger.debug(`Household gone, skipping GameShareAwaitingApproval shareId=${share.id}`);
    }

    const householdName = live.household.name;
    const authorities = await this.authorityUserIds(householdId);
    const recipients = authorities.filter((userId) => userId !== share.sharedById);

    if (recipients.length === 0) {
      return;
    }

    await this.notifications.createMany(
      recipients.map((userId) => ({
        userId,
        type: NotificationType.GameShareAwaitingApproval,
        payload: {
          householdId,
          householdName,
          shareId: share.id,
          gameId: share.gameId,
          gameTitle: live.gameTitle,
          sharerName: live.sharerName,
        },
      })),
    );
  }

  /**
   * The stored share, as a notification names what it is about, or null when
   * there is nothing left to tell: the share removed, the game soft-deleted,
   * or the sharer's user deleted between the emit and the handler. A household
   * soft-deleted in that time leaves the share's `household` null, as a share
   * to a user has it, and `notifyApprovers` tells no one of it.
   */
  private async liveShare(share: GameShareSnapshot): Promise<LiveShare | null> {
    const stored = await this.db.gameShare.findUnique({
      where: { id: share.id },
      select: SHARE_NOTICE_SELECT,
    });

    if (stored === null) {
      this.logger.debug(`Share gone, skipping notification shareId=${share.id}`);

      return null;
    }

    if (stored.game.deletedAt !== null) {
      this.logger.debug(`Game gone, skipping notification shareId=${share.id}`);

      return null;
    }

    if (stored.sharedBy === null) {
      this.logger.debug(`Sharer gone, skipping notification shareId=${share.id}`);

      return null;
    }

    const household = stored.household && stored.household.deletedAt === null ? { name: stored.household.name } : null;

    return {
      gameTitle: stored.game.title,
      sharerName: stored.sharedBy.profile?.displayName || stored.sharedBy.username,
      household,
      approvedAt: stored.approvedAt,
    };
  }

  /** The household's members who are household owners or household admins, by their role in its roster. */
  private async authorityUserIds(householdId: string): Promise<string[]> {
    const members = await this.db.householdMember.findMany({
      where: { householdId, role: { role: { name: { in: [...HOUSEHOLD_AUTHORITY_ROLES] } } } },
      select: { userId: true },
    });

    return members.map((member) => member.userId);
  }
}
