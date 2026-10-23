import { AuditContextService, requireSessionUserId } from '@bge/actor-context';
import {
  DatabaseService,
  HouseholdMembershipOrigin,
  InviteStatus,
  InviteType,
  Prisma,
  SystemRole,
} from '@bge/database';
import { t } from '@bge/i18n';
import {
  effectiveInviteStatusWhere,
  InviteService,
  OUTSTANDING_INVITE_STATUSES,
  PARTY_INVITE_SELECT,
  withEffectiveInviteStatus,
  type InvitePartyView,
  type InviteTarget,
  type RespondToInviteParams,
} from '@bge/invites';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { QuotaService } from '@bge/quota';
import { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { ConflictException, Injectable } from '@nestjs/common';
import { ListSentInvitesQueryDto } from '../dto';
import { lockExistingHousehold } from '../household-access.helpers';
import { HouseholdMemberService, type HouseholdMemberWithRelations } from '../member/household-member.service';
import { offeredRole, readInviteAuthority, senderCouldStillSend } from './household-authority';
import { receivedHouseholdInviteWhere, vouchedEmailOf } from './received-invites';

/**
 * A listed invite of the reader's, received or sent: the party shape, plus the
 * household it is into. The party shape leaves the household's id out, which
 * is right for a single invite its party acted on, and would leave a list
 * unable to tell which household each row is about.
 */
const LISTED_PARTY_INVITE_SELECT = {
  ...PARTY_INVITE_SELECT,
  household: { select: { id: true, name: true } },
} as const satisfies Prisma.InviteSelect;

export type ListedPartyInviteView = Prisma.InviteGetPayload<{ select: typeof LISTED_PARTY_INVITE_SELECT }>;

/**
 * What the sent list shows by default (#751): the invites still open, and
 * those that expired, whether or not the sweep has marked them so, so an
 * inviter sees an invite lapse and can send another. Every outstanding row is
 * in it whatever its date, and is reported `Expired` once past it.
 */
const SENT_DEFAULT_STATUSES = [...OUTSTANDING_INVITE_STATUSES, InviteStatus.Expired] as const;

/** An accepted invite, and the membership it made. */
export interface HouseholdInviteAcceptance {
  readonly invite: InvitePartyView;
  readonly member: HouseholdMemberWithRelations;
}

/**
 * A party's side of a household invite: the invites they have received,
 * accepting or declining one (#163, #164), the invites they have sent (#751),
 * and withdrawing one (#164). The household's side, creating, listing,
 * revoking and approving a household's invites, is `HouseholdInviteService`.
 *
 * No CASL rule of the acting user's stands behind any of them: a party holds
 * no grant on `Invite`, and needs none, because `@bge/invites` binds every
 * party read to the acting user in the query (#161). That is why an inviter
 * withdraws whatever their role in the household is now. The accept does ask
 * one question of a grant, of the invite's sender rather than the acting
 * user: whether they could still send it (#747). What this service adds is
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
    private readonly abilities: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly quotas: QuotaService,
  ) {}

  /**
   * One page of the invites the acting user has received, newest first: those
   * open to them in their inbox. {@link receivedHouseholdInviteWhere} says
   * which those are, and why.
   */
  async listReceived(query: PaginationQueryDto): Promise<PaginatedRows<ListedPartyInviteView>> {
    const userId = requireSessionUserId(this.auditContext.getActor());
    const vouchedEmail = await vouchedEmailOf(this.db, userId);

    return this.pageOf(receivedHouseholdInviteWhere(userId, vouchedEmail, new Date()), query);
  }

  /**
   * One page of the household invites the acting user has sent, newest first
   * (#751): how a member who invited finds their invites, since only an owner
   * or admin reads the household's list.
   *
   * By default, the invites still open and those that expired; `?status=`
   * picks any one status as it stands now, as the household's list does. Each
   * row reports its status as it stands now, so an outstanding row past its
   * date reads `Expired`.
   *
   * Only households the inviter is still in are listed. Leaving one, or being
   * removed, revokes every invite they had outstanding there (#747), so
   * nothing there is left to withdraw, and a settled invite would go on
   * telling a former member who joined. An invite into a deleted household is
   * never listed, as the inbox lists none; the delete revoked it.
   *
   * Bound to the acting user by `inviterId`, as the lib binds a party, so no
   * grant on `Invite` is asked; only a person signed in as themself reads it.
   * A withheld invite is listed like any other, since its inviter must not be
   * able to tell (#278), and the row carries no sign of it.
   */
  async listSent(query: ListSentInvitesQueryDto): Promise<PaginatedRows<ListedPartyInviteView>> {
    const userId = requireSessionUserId(this.auditContext.getActor());
    const now = new Date();

    const statusWhere: Prisma.InviteWhereInput =
      query.status === undefined
        ? { status: { in: [...SENT_DEFAULT_STATUSES] } }
        : effectiveInviteStatusWhere(query.status, now);

    const where: Prisma.InviteWhereInput = {
      type: InviteType.Household,
      inviterId: userId,
      household: { is: { deletedAt: null, members: { some: { userId } } } },
      ...statusWhere,
    };

    const { rows, total } = await this.pageOf(where, query);

    return { rows: rows.map((row) => withEffectiveInviteStatus(row, now)), total };
  }

  /**
   * One page of a party's invites, newest first, and how many match in all.
   *
   * REPEATABLE READ, so `total` and the rows come from one snapshot (#230).
   * `id` breaks ties on `createdAt`, so a row cannot cross a page boundary
   * between two requests.
   */
  private async pageOf(
    where: Prisma.InviteWhereInput,
    query: PaginationQueryDto,
  ): Promise<PaginatedRows<ListedPartyInviteView>> {
    const [rows, total] = await this.db.$transaction(
      [
        this.db.invite.findMany({
          where,
          select: LISTED_PARTY_INVITE_SELECT,
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
   *    The admission in step 6 takes the same lock again, as it must for a
   *    caller that has not; held already, it costs a round-trip and no wait.
   * 3. The lib reads the invite as it would accept it: 403 for the inviter,
   *    410 once expired, 409 once settled or still awaiting approval.
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
   * the household hold from their next request, and then the accepted invite
   * and any soft cap the admission passed are announced. An invite revoked at
   * step 4 is committed and announced before the 409 goes out.
   *
   * By token, the token is the credential: whoever holds the link is bound to
   * the invite (#161), whatever their address.
   */
  async accept(target: InviteTarget): Promise<HouseholdInviteAcceptance> {
    const inviteeId = requireSessionUserId(this.auditContext.getActor());

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
      throw new ConflictException(
        t('errors.invite.not_outstanding', { id: outcome.revoked.subjectId, status: InviteStatus.Revoked }),
      );
    }

    const { invite, member, event, softOverages } = outcome;

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
   * now, so nothing about the household is asked: a demoted inviter
   * withdraws as an Owner does. A departed one has nothing left to withdraw,
   * since leaving revoked it (#747), and meets the 409 a settled invite gets.
   * Revoking someone else's invite is `HouseholdInviteService.revokeInvite`,
   * and never stands in for this.
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
      vouchedEmail: await vouchedEmailOf(tx, inviteeId),
      type: InviteType.Household,
    };
  }
}
