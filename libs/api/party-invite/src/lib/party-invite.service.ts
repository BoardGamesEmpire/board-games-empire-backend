import { AuditContextService, requireSessionUserId } from '@bge/actor-context';
import { DatabaseService, InviteType, Prisma } from '@bge/database';
import type { HouseholdInviteAcceptance } from '@bge/household';
import {
  HouseholdInviteResponder,
  receivedHouseholdInviteWhere,
  sentHouseholdInviteWhere,
  vouchedEmailOf,
} from '@bge/household';
import { t } from '@bge/i18n';
import type { ContextualInviteType, InvitePartyView, InviteTarget } from '@bge/invites';
import { InviteService, PARTY_INVITE_SELECT, withEffectiveInviteStatus } from '@bge/invites';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListReceivedInvitesQueryDto, ListSentInvitesQueryDto } from './dto';

/**
 * A listed invite of the reader's, received or sent: the party shape, plus the
 * context it is into. The party shape leaves the context's id out, which is
 * right for a single invite its party acted on, and would leave a list unable
 * to tell which household each row is about. Each row's `type` says which
 * context it carries (#742).
 */
export const LISTED_PARTY_INVITE_SELECT = {
  ...PARTY_INVITE_SELECT,
  household: { select: { id: true, name: true } },
} as const satisfies Prisma.InviteSelect;

export type ListedPartyInviteView = Prisma.InviteGetPayload<{ select: typeof LISTED_PARTY_INVITE_SELECT }>;

/** An accepted invite, the kind it was, and what its context made of it. */
export type PartyAcceptance = HouseholdInviteAcceptance & { readonly type: typeof InviteType.Household };

/**
 * One `where` per kind of invite a party list reads, each from the lib that
 * owns that context. A kind with no lib answering for it yet has no arm.
 */
type PartyListArms = Readonly<Partial<Record<ContextualInviteType, Prisma.InviteWhereInput>>>;

/**
 * A party's side of an invite, of every kind the party routes serve (#742):
 * the invites they have received (#230), the invites they have sent (#751),
 * and accepting, declining (#163, #164) or withdrawing one (#164).
 *
 * Each action reads the invite's type, bound to the acting user as a party, in
 * a short transaction of its own, then hands the invite to the responder for
 * that type, which owns what moving it means for its context. Each list is an
 * `OR` of one arm per kind, from the lib that owns that context.
 *
 * Who the acting user may be is decided here, once per action: only a person
 * signed in as themself, since joining a household, or turning down or taking
 * back an invite, is that person's own act (#276). An API key acts for its
 * owner but is not the owner, neither a plugin nor the system joins anyone,
 * and no invite by id can name an anonymous user. No CASL rule of the acting
 * user's stands behind any of it: a party holds no grant on `Invite`, and
 * needs none, because `@bge/invites` binds every party read to the acting
 * user in the query (#161).
 */
@Injectable()
export class PartyInviteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditContext: AuditContextService,
    private readonly invites: InviteService,
    private readonly households: HouseholdInviteResponder,
  ) {}

  /**
   * One page of the invites the acting user has received, newest first: those
   * open to them in their inbox. Each context's lib says which of its invites
   * those are, and why ({@link receivedHouseholdInviteWhere}).
   */
  async listReceived(query: ListReceivedInvitesQueryDto): Promise<PaginatedRows<ListedPartyInviteView>> {
    const userId = requireSessionUserId(this.auditContext.getActor());
    const vouchedEmail = await vouchedEmailOf(this.db, userId);
    const now = new Date();

    return this.pageOf({ [InviteType.Household]: receivedHouseholdInviteWhere(userId, vouchedEmail, now) }, query);
  }

  /**
   * One page of the invites the acting user has sent, newest first (#751): how
   * an inviter who cannot read the context's own list finds their invites.
   * Each context's lib says which of its invites those are
   * ({@link sentHouseholdInviteWhere}); `?status=` picks any one status as it
   * stands now. Each row reports its status as it stands now, so an
   * outstanding row past its date reads `Expired`.
   */
  async listSent(query: ListSentInvitesQueryDto): Promise<PaginatedRows<ListedPartyInviteView>> {
    const userId = requireSessionUserId(this.auditContext.getActor());
    const now = new Date();

    const { rows, total } = await this.pageOf(
      { [InviteType.Household]: sentHouseholdInviteWhere(userId, now, query.status) },
      query,
    );

    return { rows: rows.map((row) => withEffectiveInviteStatus(row, now)), total };
  }

  /**
   * The acting user accepts an invite they received, by id or by the token
   * from its link. The responder for its type does the accepting, and the
   * answer says which type that was.
   */
  async accept(target: InviteTarget): Promise<PartyAcceptance> {
    const inviteeId = requireSessionUserId(this.auditContext.getActor());
    const responder = this.responderFor(await this.inviteeTypeOf(target, inviteeId), target);

    return { type: responder.type, ...(await responder.accept(target, inviteeId)) };
  }

  /** The acting user declines an invite they received, by id or by the token from its link. */
  async decline(target: InviteTarget): Promise<InvitePartyView> {
    const inviteeId = requireSessionUserId(this.auditContext.getActor());
    const responder = this.responderFor(await this.inviteeTypeOf(target, inviteeId), target);

    return responder.decline(target, inviteeId);
  }

  /**
   * The acting user takes back an invite they sent. The type is read bound to
   * them as its inviter, so no address of theirs is asked: an address names
   * an invitee, never an inviter.
   */
  async withdraw(inviteId: string): Promise<InvitePartyView> {
    const inviterId = requireSessionUserId(this.auditContext.getActor());
    const target = { inviteId };

    // A short transaction of its own, closed before the responder opens its own.
    const type = await this.db.$transaction((tx) =>
      this.invites.findPartyTypeWithin(tx, { target, actingUserId: inviterId }),
    );
    const responder = this.responderFor(type, target);

    return responder.withdraw(inviteId, inviterId);
  }

  /**
   * The type of an invite the acting user received, read in a short
   * transaction of its own that closes before the responder opens its own. A
   * stranger meets the 404 the transition would give. The lookup carries the
   * invitee's vouched address, so an invite to that address is theirs by id,
   * as its link would make it.
   */
  private async inviteeTypeOf(target: InviteTarget, inviteeId: string): Promise<ContextualInviteType> {
    return this.db.$transaction(async (tx) =>
      this.invites.findPartyTypeWithin(tx, {
        target,
        actingUserId: inviteeId,
        vouchedEmail: await vouchedEmailOf(tx, inviteeId),
      }),
    );
  }

  /**
   * The responder for an invite of this type. A type no lib answers for yet
   * meets the 404 a stranger meets, worded as `@bge/invites` words it, so the
   * answer never confirms that the invite exists.
   */
  private responderFor(type: ContextualInviteType, target: InviteTarget): HouseholdInviteResponder {
    if (type === this.households.type) {
      return this.households;
    }

    // The token is never echoed.
    throw new NotFoundException(
      'inviteId' in target ? t('errors.invite.not_found', { id: target.inviteId }) : t('errors.invite.link_not_found'),
    );
  }

  /**
   * One page of a party's invites, newest first, and how many match in all.
   * `type` keeps one arm; a kind with no arm answers an empty page without a
   * query.
   *
   * REPEATABLE READ, so `total` and the rows come from one snapshot (#230).
   * `id` breaks ties on `createdAt`, so a row cannot cross a page boundary
   * between two requests.
   */
  private async pageOf(
    arms: PartyListArms,
    query: PaginationQueryDto & { readonly type?: ContextualInviteType },
  ): Promise<PaginatedRows<ListedPartyInviteView>> {
    const chosenArms = query.type === undefined ? Object.values(arms) : [arms[query.type]];
    const servedArms = chosenArms.filter((arm): arm is Prisma.InviteWhereInput => arm !== undefined);

    if (servedArms.length === 0) {
      return { rows: [], total: 0 };
    }

    const where: Prisma.InviteWhereInput = { OR: servedArms };

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
}
