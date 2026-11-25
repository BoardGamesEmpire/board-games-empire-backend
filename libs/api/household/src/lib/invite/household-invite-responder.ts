import type { Prisma } from '@bge/database';
import { DatabaseService, HouseholdMembershipOrigin, InviteStatus, InviteType, SystemRole } from '@bge/database';
import { t } from '@bge/i18n';
import type { InvitePartyView, InviteResponder, InviteTarget, RespondToInviteParams } from '@bge/invites';
import { inviteNotOutstanding, InviteService } from '@bge/invites';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { QuotaService } from '@bge/quota';
import { ConflictException, Injectable } from '@nestjs/common';
import { lockExistingHousehold } from '../household-access.helpers';
import type { HouseholdMemberWithRelations } from '../member/household-member.service';
import { HouseholdMemberService } from '../member/household-member.service';
import { offeredRole, readInviteAuthority, senderCouldStillSend } from './household-authority';
import { vouchedEmailOf } from './received-invites';

/** An accepted invite, and the membership it made. */
export interface HouseholdInviteAcceptance {
  readonly invite: InvitePartyView;
  readonly member: HouseholdMemberWithRelations;
}

/**
 * A party's answers to a household invite: accepting or declining one they
 * received (#163, #164), and withdrawing one they sent (#164). The party
 * routes hand a household invite here once they know its type (#742). The
 * household's side, creating, listing, revoking and approving a household's
 * invites, is `HouseholdInviteService`.
 *
 * No CASL rule of the acting user's stands behind any of them: a party holds
 * no grant on `Invite`, and needs none, because `@bge/invites` binds every
 * party read to the acting user in the query (#161). That is why an inviter
 * withdraws whatever their role in the household is now. The accept does ask
 * one question of a grant, of the invite's sender rather than the acting
 * user: whether they could still send it (#747). What this responder adds is
 * whose address may stand in for that binding. The party route resolves who
 * the acting user may be and passes them in (`PartyInviteService`, #276).
 */
@Injectable()
export class HouseholdInviteResponder implements InviteResponder<HouseholdInviteAcceptance> {
  readonly type = InviteType.Household;

  constructor(
    private readonly db: DatabaseService,
    private readonly invites: InviteService,
    private readonly members: HouseholdMemberService,
    private readonly abilities: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly quotas: QuotaService,
  ) {}

  /**
   * The acting user accepts an invite and joins its household, in one
   * transaction:
   *
   * 1. The invite's household is read, bound to the acting user as invitee,
   *    so a stranger meets a 404 that names no household.
   * 2. The household row is share-locked. A soft delete locks it before it
   *    revokes the household's invites; accepting first and locking second
   *    would take the two in the other order, and Postgres would abort one.
   *    The admission in step 6 takes the same lock again, as it must for a
   *    caller that has not; held already, it costs a round-trip and no wait.
   * 3. The lib reads the invite as it would accept it: 403 for the inviter,
   *    409 once expired, settled or still awaiting approval.
   * 4. Its sender must still be able to send it ({@link senderCouldStillSend},
   *    on the roster and policy read under the lock). If not, it is revoked
   *    instead, and the answer is the 409 a revoked invite gets (#747). Unless
   *    the acting user is already a member: then the answer is step 7's, and
   *    nothing is revoked, for step 7's reason.
   * 5. The lib accepts.
   * 6. The member is admitted with the role the invite offers, as invited by
   *    its inviter. Past the household's member cap the answer is 402.
   * 7. Someone already a member joins nobody, so the answer is 409 and the
   *    rollback leaves the invite outstanding. Settling it would tell its
   *    inviter whose address it was, and no settled status would be true.
   *
   * After commit the new member's ability cache is evicted, so their grants on
   * the household hold from their next request, and then the accepted invite,
   * the admission (#245) and any soft cap the admission passed are announced.
   * An invite revoked at step 4 is committed and announced before the 409 goes
   * out. Neither 409 admitted anyone, so neither publishes an admission.
   *
   * By token, the token is the credential: whoever holds the link is bound to
   * the invite (#161), whatever their address.
   */
  async accept(target: InviteTarget, inviteeId: string): Promise<HouseholdInviteAcceptance> {
    const initiatedAt = new Date();

    const outcome = await this.db.$transaction(async (tx) => {
      const lookup = await this.inviteeLookup(tx, target, inviteeId);

      const { householdId } = await this.invites.findPartyScopeWithin(tx, lookup, InviteType.Household);
      await lockExistingHousehold(tx, householdId);

      const offer = await this.invites.findAcceptableWithin(tx, lookup);
      const authority = await readInviteAuthority(tx, householdId);
      const sender = { ...offer, role: offeredRole(offer) ?? SystemRole.HouseholdMember };

      if (!(await senderCouldStillSend(this.abilities, tx, householdId, sender, authority))) {
        if (authority.members.some((member) => member.userId === inviteeId)) {
          throw new ConflictException(t('errors.household.already_a_member', { householdId }));
        }

        const { event } = await this.invites.revokeWithin(tx, {
          inviteId: offer.id,
          revokerId: inviteeId,
          scope: { householdId },
        });

        return { accepted: false as const, revoked: event };
      }

      const accepted = await this.invites.acceptWithin(tx, lookup);

      const admission = await this.members.addMemberWithin(tx, {
        householdId,
        userId: inviteeId,
        role: offeredRole(accepted.invite),
        origin: HouseholdMembershipOrigin.InviteAccepted,
        addedById: accepted.invite.inviter.id,
      });

      if (!admission.admitted) {
        throw new ConflictException(t('errors.household.already_a_member', { householdId }));
      }

      return { accepted: true as const, ...accepted, ...admission };
    });

    if (!outcome.accepted) {
      this.invites.emit([outcome.revoked]);

      // The answer a revoked invite gets, so the invitee learns nothing of why.
      throw inviteNotOutstanding(InviteStatus.Revoked);
    }

    const { invite, member, event, softOverages } = outcome;

    await this.permissions.invalidateUser(inviteeId);
    this.invites.emit([event]);
    this.members.emitMemberAdmitted(member, HouseholdMembershipOrigin.InviteAccepted, initiatedAt);
    this.quotas.emitSoftOverages(softOverages);

    return { invite, member };
  }

  /**
   * The acting user declines an invite they received, by id or by the token
   * from its link (#164). From `Pending`, or from `AwaitingApproval`: a
   * refusal never waits on an approver.
   *
   * The lib's read is bound to a household invite, so an invite of another
   * type is the 404 a stranger meets. Only the invite row moves, so no
   * household lock is taken; a soft delete that revoked the invite first
   * leaves the decline its 409. The lib answers the rest: 403 for the
   * inviter, 409 once expired or settled. After commit the declined
   * invite is announced.
   */
  async decline(target: InviteTarget, inviteeId: string): Promise<InvitePartyView> {
    const { invite, event } = await this.db.$transaction(async (tx) =>
      this.invites.declineWithin(tx, await this.inviteeLookup(tx, target, inviteeId)),
    );

    this.invites.emit([event]);

    return invite;
  }

  /**
   * The acting user takes back an invite they sent (#164), from either
   * outstanding status. It is theirs whatever their role in the household
   * now, so nothing about the household is asked: a demoted inviter
   * withdraws as an Owner does. A departed one has nothing left to withdraw,
   * since leaving revoked it (#747), and meets the 409 a settled invite gets.
   * Revoking someone else's invite is `HouseholdInviteService.revokeInvite`,
   * and never stands in for this.
   *
   * Bound to a household invite as {@link decline} is, and for the same
   * reason no lock is taken. The lib answers 404 to anyone who is not a party,
   * 403 to the invitee, 409 once expired or settled. After commit
   * the withdrawn invite is announced.
   */
  async withdraw(inviteId: string, inviterId: string): Promise<InvitePartyView> {
    const { invite, event } = await this.db.$transaction((tx) =>
      this.invites.withdrawWithin(tx, { inviteId, actingUserId: inviterId, type: InviteType.Household }),
    );

    this.invites.emit([event]);

    return invite;
  }

  /** How an invitee names a household invite of theirs to the lib: the target, their vouched address, the type. */
  private async inviteeLookup(
    tx: Prisma.TransactionClient,
    target: InviteTarget,
    inviteeId: string,
  ): Promise<RespondToInviteParams> {
    return {
      target,
      actingUserId: inviteeId,
      vouchedEmail: await vouchedEmailOf(tx, inviteeId),
      type: InviteType.Household,
    };
  }
}
