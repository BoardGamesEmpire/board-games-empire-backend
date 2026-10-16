import { AuditContextService, requireSessionUserId } from '@bge/actor-context';
import { DatabaseService, HouseholdMembershipOrigin, InviteType, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import {
  InviteService,
  OUTSTANDING_INVITE_STATUSES,
  PARTY_INVITE_SELECT,
  receivedInviteWhere,
  unexpiredInviteWhere,
  type InvitePartyView,
  type InviteTarget,
  type RespondToInviteParams,
} from '@bge/invites';
import { PermissionsService } from '@bge/permissions';
import { QuotaService } from '@bge/quota';
import { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { ConflictException, Injectable } from '@nestjs/common';
import { isAssignableHouseholdRole, type AssignableHouseholdRole } from '../dto';
import { lockExistingHousehold } from '../household-access.helpers';
import { HouseholdMemberService, type HouseholdMemberWithRelations } from '../member/household-member.service';

/**
 * A received invite: the party shape, plus the household that sent it. The
 * party shape leaves the household's id out, which is right for an inviter
 * and leaves an invitee unable to tell which household is asking.
 */
const RECEIVED_INVITE_SELECT = {
  ...PARTY_INVITE_SELECT,
  household: { select: { id: true, name: true } },
} as const satisfies Prisma.InviteSelect;

export type ReceivedInviteView = Prisma.InviteGetPayload<{ select: typeof RECEIVED_INVITE_SELECT }>;

/** An accepted invite, and the membership it made. */
export interface HouseholdInviteAcceptance {
  readonly invite: InvitePartyView;
  readonly member: HouseholdMemberWithRelations;
}

/**
 * A party's side of a household invite: the invites they have received,
 * accepting or declining one (#163, #164), and withdrawing one they sent
 * (#164). The household's side, creating, listing and revoking a household's
 * invites, is `HouseholdInviteService`.
 *
 * No CASL rule stands behind any of them: a party holds no grant on `Invite`,
 * and needs none, because `@bge/invites` binds every party read to the acting
 * user in the query (#161). That is why an inviter withdraws whatever their
 * role in the household is now, demoted or gone. What this service adds is
 * whose address may stand in for that binding, and who the acting user may
 * be: only a person signed in as themself, since joining a household, or
 * turning down or taking back an invite, is that person's own act (#276). An
 * API key acts for its owner but is not the owner, neither a plugin nor the
 * system joins anyone, and no invite by id can name an anonymous guest.
 */
@Injectable()
export class PartyInviteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditContext: AuditContextService,
    private readonly invites: InviteService,
    private readonly members: HouseholdMemberService,
    private readonly permissions: PermissionsService,
    private readonly quotas: QuotaService,
  ) {}

  /**
   * One page of the invites the acting user has received, newest first: those
   * naming them by id, and those to their verified address. Only the ones
   * still open to them are listed: outstanding, unexpired, into a household
   * that is live and that they are not already in. One awaiting approval is
   * listed, though its accept is refused until it is approved (#166). A
   * withheld invite never is (#278); the lib's filter leaves it out.
   *
   * An invite into a household they already belong to stays outstanding (an
   * accept of it is refused), so it is hidden rather than offered.
   */
  async listReceived(query: PaginationQueryDto): Promise<PaginatedRows<ReceivedInviteView>> {
    const userId = requireSessionUserId(this.auditContext.getActor());
    const vouchedEmail = await this.vouchedEmailOf(this.db, userId);
    const now = new Date();

    const where: Prisma.InviteWhereInput = {
      type: InviteType.Household,
      AND: [
        receivedInviteWhere(userId, vouchedEmail),
        { status: { in: [...OUTSTANDING_INVITE_STATUSES] } },
        unexpiredInviteWhere(now),
        { household: { is: { deletedAt: null, members: { none: { userId } } } } },
      ],
    };

    // REPEATABLE READ, so `total` and the rows come from one snapshot (#230).
    // `id` breaks ties on `createdAt`, so a row cannot cross a page boundary
    // between two requests.
    const [rows, total] = await this.db.$transaction(
      [
        this.db.invite.findMany({
          where,
          select: RECEIVED_INVITE_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: query.skip,
          take: query.pageSize,
        }),

        this.db.invite.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /**
   * The acting user accepts an invite and joins its household, in one
   * transaction:
   *
   * 1. The invite's household is read, bound to the acting user as invitee,
   *    so a stranger meets a 404 that names no household.
   * 2. The household row is share-locked. A soft delete locks it before it
   *    revokes the household's invites; accepting first and locking second
   *    would take the two in the other order, and Postgres would abort one.
   *    The admission in step 4 takes the same lock again, as it must for a
   *    caller that has not; held already, it costs a round-trip and no wait.
   * 3. The lib accepts: 403 for the inviter, 410 once expired, 409 once
   *    settled or still awaiting approval.
   * 4. The member is admitted with the role the invite offers, as invited by
   *    its inviter. Past the household's member cap the answer is 402.
   * 5. Someone already a member joins nobody, so the answer is 409 and the
   *    rollback leaves the invite outstanding. Settling it would tell its
   *    inviter whose address it was, and no settled status would be true.
   *
   * After commit the new member's ability cache is evicted, so their grants on
   * the household hold from their next request, and then the accepted invite
   * and any soft cap the admission passed are announced.
   *
   * By token, the token is the credential: whoever holds the link is bound to
   * the invite (#161), whatever their address.
   */
  async accept(target: InviteTarget): Promise<HouseholdInviteAcceptance> {
    const inviteeId = requireSessionUserId(this.auditContext.getActor());

    const { invite, member, event, softOverages } = await this.db.$transaction(async (tx) => {
      const lookup = await this.inviteeLookup(tx, target, inviteeId);

      const { householdId } = await this.invites.findPartyScopeWithin(tx, lookup, InviteType.Household);
      await lockExistingHousehold(tx, householdId);

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

      return { ...accepted, ...admission };
    });

    await this.permissions.invalidateUser(inviteeId);
    this.invites.emit([event]);
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
   * inviter, 410 once expired, 409 once settled. After commit the declined
   * invite is announced.
   */
  async decline(target: InviteTarget): Promise<InvitePartyView> {
    const inviteeId = requireSessionUserId(this.auditContext.getActor());

    const { invite, event } = await this.db.$transaction(async (tx) =>
      this.invites.declineWithin(tx, await this.inviteeLookup(tx, target, inviteeId)),
    );

    this.invites.emit([event]);

    return invite;
  }

  /**
   * The acting user takes back an invite they sent (#164), from either
   * outstanding status. It is theirs whatever their role in the household
   * now, so nothing about the household is asked: a demoted or departed
   * inviter withdraws as an Owner does. Revoking someone else's invite is
   * `HouseholdInviteService.revokeInvite`, and never stands in for this.
   *
   * Bound to a household invite as {@link decline} is, and for the same
   * reason no lock is taken. The lib answers 404 to anyone who is not a party,
   * 403 to the invitee, 410 once expired and 409 once settled. After commit
   * the withdrawn invite is announced.
   */
  async withdraw(inviteId: string): Promise<InvitePartyView> {
    const inviterId = requireSessionUserId(this.auditContext.getActor());

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
      vouchedEmail: await this.vouchedEmailOf(tx, inviteeId),
      type: InviteType.Household,
    };
  }

  /**
   * The address the household routes vouch is the user's: their own, once
   * verified. Anyone can register an address they cannot read, and vouching
   * for that one would hand them every invite sent to it. Whether more than a
   * verified address should count is #724's question, and this is the one
   * place it is answered.
   */
  private async vouchedEmailOf(
    client: DatabaseService | Prisma.TransactionClient,
    userId: string,
  ): Promise<string | null> {
    const user = await client.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } });

    return user?.emailVerified ? user.email : null;
  }
}

/**
 * The role an invite offers, as the admission takes it. The create stores
 * only an assignable role, so another is drift in the data: a server error,
 * and nothing the invitee did. No role is the seam's default, the least of
 * them.
 */
function offeredRole(invite: InvitePartyView): AssignableHouseholdRole | undefined {
  const name = invite.role?.name;

  if (name === undefined) {
    return undefined;
  }

  if (!isAssignableHouseholdRole(name)) {
    throw new Error(`Invite ${invite.id} offers the role '${name}', which no household admission grants`);
  }

  return name;
}
