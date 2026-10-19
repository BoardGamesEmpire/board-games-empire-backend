import { DatabaseService, InviteStatus, InviteType, NotificationType } from '@bge/database';
import type { InviteApprovedEvent, InviteCreatedEvent, InviteSnapshot } from '@bge/invites';
import { InviteEvents } from '@bge/invites';
import type { HouseholdRefPayload } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { HOUSEHOLD_AUTHORITY_ROLES } from '../invite/household-authority';
import { receivedHouseholdInviteWhere, vouchedEmailOf } from '../invite/received-invites';
import { SHOWN_NAME_SELECT, shownName } from '../shown-name';

/** A household invite's snapshot, which therefore names its household. */
type HouseholdInviteSnapshot = InviteSnapshot & { readonly householdId: string };

/**
 * Whether the snapshot is a household invite, the only kind this listener
 * tells anyone about. Event invites (#742) are announced under the same
 * `invite.*` names.
 */
function isHouseholdInvite(invite: InviteSnapshot): invite is HouseholdInviteSnapshot {
  return invite.type === InviteType.Household && invite.householdId !== null;
}

/**
 * Tells people about their households (#167): an invitee of an invite their
 * inbox now lists, and household owners and admins of an invite waiting for
 * their approval.
 *
 * Every event it hears is emitted after its transaction commits, so the
 * request has already answered. A handler therefore never throws: it logs its
 * own failure and resolves, and the notification is lost rather than the
 * change it reports.
 */
@Injectable()
export class HouseholdNotificationListener {
  private readonly logger = new Logger(HouseholdNotificationListener.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * An invite opens either `Pending`, as the household's offer, or
   * `AwaitingApproval`, as a member's proposal (#166). The invitee hears of a
   * `Pending` one now. Of one awaiting approval they hear nothing until it is
   * approved: their inbox does not list it, and telling them would tell them
   * about the household's own deliberations. The household owners and admins
   * are told that it is waiting for them instead.
   */
  @OnEvent(InviteEvents.Created, { async: true })
  async onInviteCreated(event: InviteCreatedEvent): Promise<void> {
    const invite = event.after;

    if (!isHouseholdInvite(invite)) {
      return;
    }

    try {
      if (invite.status === InviteStatus.Pending) {
        await this.notifyInvitee(invite);
      } else if (invite.status === InviteStatus.AwaitingApproval) {
        await this.notifyApprovers(invite);
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify on InviteCreated inviteId=${invite.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** An invite that waited is approved (#166): it is now the household's offer, and its invitee hears of it. */
  @OnEvent(InviteEvents.Approved, { async: true })
  async onInviteApproved(event: InviteApprovedEvent): Promise<void> {
    const invite = event.after;

    if (!isHouseholdInvite(invite)) {
      return;
    }

    try {
      await this.notifyInvitee(invite);
    } catch (err) {
      this.logger.error(
        `Failed to notify on InviteApproved inviteId=${invite.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Tells the invitee of an invite, exactly when their inbox would list it
   * (#167). The inbox's own predicate is asked about this one invite, so no
   * one hears of an invite their inbox hides: one to an address they have not
   * verified, into a household they already belong to, from themselves, or
   * withheld from whoever holds the address (#278). The household and the
   * inviter's name are read alongside it.
   */
  private async notifyInvitee(invite: HouseholdInviteSnapshot): Promise<void> {
    const inviteeId = await this.inviteeIdOf(invite);

    if (inviteeId === null) {
      return;
    }

    const [listed, household, inviterName] = await Promise.all([
      this.inboxLists(invite.id, inviteeId, new Date()),
      this.householdRef(invite.householdId),
      this.nameOf(invite.inviterId),
    ]);

    if (!listed) {
      return;
    }

    if (!household || inviterName === null) {
      return this.logger.debug(`Household or inviter gone, skipping HouseholdInviteReceived inviteId=${invite.id}`);
    }

    await this.notifications.create({
      userId: inviteeId,
      type: NotificationType.HouseholdInviteReceived,
      payload: { ...household, inviteId: invite.id, inviterName },
    });
  }

  /**
   * The user the invite is for, or null when no user holds its address. An
   * invite by id names its user. One by address is matched exactly, as the
   * invitee gate matches it, because better-auth lower-cases an address on
   * every path that writes one and the invite stores its address lower-cased
   * too. `User.email` is unique, so at most one user holds it.
   */
  private async inviteeIdOf(invite: HouseholdInviteSnapshot): Promise<string | null> {
    if (invite.inviteeId !== null) {
      return invite.inviteeId;
    }

    if (invite.inviteeEmail === null) {
      return null;
    }

    const user = await this.db.user.findUnique({ where: { email: invite.inviteeEmail }, select: { id: true } });

    return user?.id ?? null;
  }

  /** Whether the user's inbox lists the invite, asked by the inbox's own predicate. */
  private async inboxLists(inviteId: string, userId: string, now: Date): Promise<boolean> {
    const vouchedEmail = await vouchedEmailOf(this.db, userId);
    const count = await this.db.invite.count({
      where: { id: inviteId, AND: [receivedHouseholdInviteWhere(userId, vouchedEmail, now)] },
    });

    return count === 1;
  }

  /**
   * Tells the household owners and admins that an invite waits for their
   * approval (#167), all but the inviter, who knows. Who becomes a member of
   * their household is theirs to answer for, so they see the invitee as the
   * invite names them: the name and address as given, and a user only when it
   * was sent by id.
   */
  private async notifyApprovers(invite: HouseholdInviteSnapshot): Promise<void> {
    const [authorities, household, inviterName] = await Promise.all([
      this.authorityUserIds(invite.householdId),
      this.householdRef(invite.householdId),
      this.nameOf(invite.inviterId),
    ]);
    const recipients = authorities.filter((userId) => userId !== invite.inviterId);

    if (recipients.length === 0) {
      return;
    }

    if (!household || inviterName === null) {
      return this.logger.debug(
        `Household or inviter gone, skipping HouseholdInviteAwaitingApproval inviteId=${invite.id}`,
      );
    }

    await this.notifications.createMany(
      recipients.map((userId) => ({
        userId,
        type: NotificationType.HouseholdInviteAwaitingApproval,
        payload: {
          ...household,
          inviteId: invite.id,
          inviterName,
          inviteeId: invite.inviteeId,
          inviteeName: invite.inviteeName,
          inviteeEmail: invite.inviteeEmail,
        },
      })),
    );
  }

  /**
   * The household as a notification names it, or null once it is gone. A
   * household soft-deleted between the emit and the handler revokes its
   * invites, and has nothing more to tell anyone.
   */
  private async householdRef(householdId: string): Promise<HouseholdRefPayload | null> {
    const household = await this.db.household.findUnique({
      where: { id: householdId },
      select: { name: true, deletedAt: true },
    });

    return household && household.deletedAt === null ? { householdId, householdName: household.name } : null;
  }

  /** The household's members who are household owners or household admins, by their role in its roster. */
  private async authorityUserIds(householdId: string): Promise<string[]> {
    const members = await this.db.householdMember.findMany({
      where: { householdId, role: { role: { name: { in: [...HOUSEHOLD_AUTHORITY_ROLES] } } } },
      select: { userId: true },
    });

    return members.map((member) => member.userId);
  }

  /** A user's name as it is shown now, or null once the user is deleted. */
  private async nameOf(userId: string): Promise<string | null> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: SHOWN_NAME_SELECT });

    return user ? shownName(user) : null;
  }
}
