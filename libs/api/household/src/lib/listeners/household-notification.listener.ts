import { DatabaseService, InviteStatus, InviteType, NotificationType } from '@bge/database';
import type {
  InviteAcceptedEvent,
  InviteApprovedEvent,
  InviteCreatedEvent,
  InviteDeclinedEvent,
  InviteSnapshot,
} from '@bge/invites';
import { InviteEvents } from '@bge/invites';
import type { HouseholdRefPayload } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { HouseholdEvents } from '../constants/household-events.constant';
import type { HouseholdOwnershipSnapshot, HouseholdOwnershipTransferredEvent } from '../events/household.events';
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
 * inbox now lists, household owners and admins of an invite waiting for their
 * approval, the members of a household of its new member, and the inviter and
 * the household owners and admins of an invite declined (#682), and a new
 * household owner of the household they were handed (#246).
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

  /**
   * Invites a lifted household ban released (#782): their invitee hears of
   * each one their inbox now lists, as of an invite just sent. Called by the
   * ban service after commit rather than through an event, which would carry
   * an invite that was withheld to the audit log. One by one, so one failure
   * loses only its own notification.
   */
  async onInvitesReleased(invites: readonly InviteSnapshot[]): Promise<void> {
    for (const invite of invites) {
      if (!isHouseholdInvite(invite) || invite.status !== InviteStatus.Pending) {
        continue;
      }

      try {
        await this.notifyInvitee(invite);
      } catch (err) {
        this.logger.error(
          `Failed to notify on a released invite inviteId=${invite.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
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
   * The invitee accepted and is a member now (#682). Every other member is
   * told who, so a household hears of a new member from the server instead of
   * finding them on the roster. The new member is the after-snapshot's
   * invitee: an invite by address binds a user only on accept, so before it no
   * one is named.
   */
  @OnEvent(InviteEvents.Accepted, { async: true })
  async onInviteAccepted(event: InviteAcceptedEvent): Promise<void> {
    const invite = event.after;

    if (!isHouseholdInvite(invite)) {
      return;
    }

    try {
      await this.notifyMembers(invite);
    } catch (err) {
      this.logger.error(
        `Failed to notify on InviteAccepted inviteId=${invite.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * The invitee declined (#682). The inviter is told, if they are still a
   * member, and so are the household owners and admins, who answer for who
   * becomes a member. Each hears once, and the one declining never does.
   */
  @OnEvent(InviteEvents.Declined, { async: true })
  async onInviteDeclined(event: InviteDeclinedEvent): Promise<void> {
    const invite = event.after;

    if (!isHouseholdInvite(invite)) {
      return;
    }

    try {
      await this.notifyDeclined(invite, event.before);
    } catch (err) {
      this.logger.error(
        `Failed to notify on InviteDeclined inviteId=${invite.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Household ownership changed hands (#246). The new household owner is told
   * that the household is theirs and who held it before them. The previous
   * household owner is not: only a household owner can transfer today, so they
   * made the transfer and know.
   */
  @OnEvent(HouseholdEvents.OwnershipTransferred, { async: true })
  async onOwnershipTransferred(event: HouseholdOwnershipTransferredEvent): Promise<void> {
    const { before, after } = event;

    try {
      await this.notifyNewOwner(before, after);
    } catch (err) {
      this.logger.error(
        `Failed to notify on HouseholdOwnershipTransferred householdId=${after.householdId}`,
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

    const [listed, named] = await Promise.all([
      this.inboxLists(invite.id, inviteeId, new Date()),
      this.householdAndName(invite.householdId, invite.inviterId),
    ]);

    if (!listed) {
      return;
    }

    if (!named) {
      return this.logger.debug(`Household or inviter gone, skipping HouseholdInviteReceived inviteId=${invite.id}`);
    }

    const { household, name: inviterName } = named;

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
    const [authorities, named] = await Promise.all([
      this.authorityUserIds(invite.householdId),
      this.householdAndName(invite.householdId, invite.inviterId),
    ]);
    const recipients = authorities.filter((userId) => userId !== invite.inviterId);

    if (recipients.length === 0) {
      return;
    }

    if (!named) {
      return this.logger.debug(
        `Household or inviter gone, skipping HouseholdInviteAwaitingApproval inviteId=${invite.id}`,
      );
    }

    const { household, name: inviterName } = named;

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
   * Tells the members of a household who its new member is (#682), all but
   * the new member, who knows. They are given the new member's name and never
   * an address, even where the invite was sent to one.
   */
  private async notifyMembers(invite: HouseholdInviteSnapshot): Promise<void> {
    const newMemberId = invite.inviteeId;

    if (newMemberId === null) {
      return this.logger.debug(`Accept names no new member, skipping HouseholdInviteAccepted inviteId=${invite.id}`);
    }

    const [members, named] = await Promise.all([
      this.db.householdMember.findMany({
        where: { householdId: invite.householdId, userId: { not: newMemberId } },
        select: { userId: true },
      }),
      this.householdAndName(invite.householdId, newMemberId),
    ]);

    if (members.length === 0) {
      return;
    }

    if (!named) {
      return this.logger.debug(`Household or new member gone, skipping HouseholdInviteAccepted inviteId=${invite.id}`);
    }

    const { household, name: memberName } = named;

    await this.notifications.createMany(
      members.map(({ userId }) => ({
        userId,
        type: NotificationType.HouseholdInviteAccepted,
        payload: { ...household, inviteId: invite.id, memberUserId: newMemberId, memberName },
      })),
    );
  }

  /**
   * Tells the inviter, if they are still a member, and the household owners
   * and admins that an invite was declined (#682), each once and never the
   * person declining. They see the invitee as the invite named them, in the
   * before-snapshot: declining binds the user to an invite sent by address,
   * and the after-snapshot would then name a user the invite never did.
   */
  private async notifyDeclined(invite: HouseholdInviteSnapshot, invitedAs: InviteSnapshot): Promise<void> {
    const [authorities, inviterMembership, household] = await Promise.all([
      this.authorityUserIds(invite.householdId),
      this.db.householdMember.findUnique({
        where: { householdId_userId: { householdId: invite.householdId, userId: invite.inviterId } },
        select: { userId: true },
      }),
      this.householdRef(invite.householdId),
    ]);

    const recipients = new Set(authorities);

    if (inviterMembership) {
      recipients.add(invite.inviterId);
    }

    if (invite.inviteeId !== null) {
      recipients.delete(invite.inviteeId);
    }

    if (recipients.size === 0) {
      return;
    }

    if (!household) {
      return this.logger.debug(`Household gone, skipping HouseholdInviteDeclined inviteId=${invite.id}`);
    }

    await this.notifications.createMany(
      [...recipients].map((userId) => ({
        userId,
        type: NotificationType.HouseholdInviteDeclined,
        payload: {
          ...household,
          inviteId: invite.id,
          inviteeId: invitedAs.inviteeId,
          inviteeName: invitedAs.inviteeName,
          inviteeEmail: invitedAs.inviteeEmail,
        },
      })),
    );
  }

  /**
   * Tells the new household owner that the household is theirs (#246), naming
   * them and the previous household owner by member id and by name as it is
   * shown now, since the snapshots carry ids only. Nothing is sent when the
   * household, or the new household owner, is gone between the emit and the
   * handler. A previous household owner whose user was deleted in that time
   * is named by member id alone: what the new household owner must hear is
   * that the household is theirs, and who held it before is a detail.
   */
  private async notifyNewOwner(before: HouseholdOwnershipSnapshot, after: HouseholdOwnershipSnapshot): Promise<void> {
    const [named, previousOwnerName] = await Promise.all([
      this.householdAndName(after.householdId, after.ownerUserId),
      this.nameOf(before.ownerUserId),
    ]);

    if (!named) {
      return this.logger.debug(
        `Household or new household owner gone, skipping HouseholdOwnershipTransferred householdId=${after.householdId}`,
      );
    }

    const { household, name: newOwnerName } = named;

    await this.notifications.create({
      userId: after.ownerUserId,
      type: NotificationType.HouseholdOwnershipTransferred,
      payload: {
        ...household,
        previousOwnerMemberId: before.ownerMemberId,
        previousOwnerName,
        newOwnerMemberId: after.ownerMemberId,
        newOwnerName,
      },
    });
  }

  /**
   * The household and one user's name, as a notification names them, or null
   * when either is gone: the household soft-deleted, or the user deleted,
   * between the emit and the handler.
   */
  private async householdAndName(
    householdId: string,
    userId: string,
  ): Promise<{ household: HouseholdRefPayload; name: string } | null> {
    const [household, name] = await Promise.all([this.householdRef(householdId), this.nameOf(userId)]);

    return household && name !== null ? { household, name } : null;
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
