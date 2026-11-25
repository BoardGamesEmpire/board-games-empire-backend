import { AuditContextService, requireSessionUserId } from '@bge/actor-context';
import { DatabaseService, InviteType, Prisma } from '@bge/database';
import type { EventInviteAcceptance } from '@bge/event';
import { EventInviteResponder, receivedEventInviteWhere, sentEventInviteWhere } from '@bge/event';
import type { HouseholdInviteAcceptance } from '@bge/household';
import {
  HouseholdInviteResponder,
  receivedHouseholdInviteWhere,
  sentHouseholdInviteWhere,
  vouchedEmailOf,
} from '@bge/household';
import type { ContextualInviteType, InvitePartyView, InviteResponder, InviteTarget } from '@bge/invites';
import { CONTEXTUAL_INVITE_TYPES, InviteService, PARTY_INVITE_SELECT, withEffectiveInviteStatus } from '@bge/invites';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import type { ListReceivedInvitesQueryDto, ListSentInvitesQueryDto } from './dto';

/**
 * A listed invite of the reader's, received or sent: the party shape, plus the
 * context it is into. The party shape leaves the context's id out, which is
 * right for a single invite its party acted on, and would leave a list unable
 * to tell which household or event each row is about. Each row's `type` says
 * which context it carries: a household invite its `household`, an event
 * invite its `event`, and the other `null` (#742).
 */
export const LISTED_PARTY_INVITE_SELECT = {
  ...PARTY_INVITE_SELECT,
  household: { select: { id: true, name: true } },
  event: { select: { id: true, title: true } },
} as const satisfies Prisma.InviteSelect;

export type ListedPartyInviteView = Prisma.InviteGetPayload<{ select: typeof LISTED_PARTY_INVITE_SELECT }>;

/**
 * An accepted invite, the kind it was, and what its context made of it: a
 * household membership, or an attendee row (#742). `type` tells them apart.
 */
export type PartyAcceptance =
  | (EventInviteAcceptance & { readonly type: typeof InviteType.Event })
  | (HouseholdInviteAcceptance & { readonly type: typeof InviteType.Household });

/**
 * One `where` per kind of invite a party list reads, each from the lib that
 * owns that context. Every kind the party routes serve has one, so a kind
 * added to them without its arm fails to compile (#742).
 */
type PartyListArms = Readonly<Record<ContextualInviteType, Prisma.InviteWhereInput>>;

/** A responder as decline and withdraw use it, whatever its context makes of an accept. */
type PartyResponder = InviteResponder<{ readonly invite: InvitePartyView }>;

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
 * signed in as themself, since joining a household or an event, or turning
 * down or taking back an invite, is that person's own act (#276). An API key acts for its
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
    private readonly events: EventInviteResponder,
  ) {}

  /**
   * One page of the invites the acting user has received, newest first: those
   * open to them in their inbox. Each context's lib says which of its invites
   * those are, and why ({@link receivedHouseholdInviteWhere},
   * {@link receivedEventInviteWhere}).
   */
  async listReceived(query: ListReceivedInvitesQueryDto): Promise<PaginatedRows<ListedPartyInviteView>> {
    const userId = requireSessionUserId(this.auditContext.getActor());
    const vouchedEmail = await vouchedEmailOf(this.db, userId);
    const now = new Date();

    return this.pageOf(
      {
        [InviteType.Household]: receivedHouseholdInviteWhere(userId, vouchedEmail, now),
        [InviteType.Event]: receivedEventInviteWhere(userId, now),
      },
      query,
    );
  }

  /**
   * One page of the invites the acting user has sent, newest first (#751): how
   * an inviter who cannot read the context's own list finds their invites.
   * Each context's lib says which of its invites those are
   * ({@link sentHouseholdInviteWhere}, {@link sentEventInviteWhere});
   * `?status=` picks any one status as it stands now. Each row reports its
   * status as it stands now, so an outstanding row past its date reads
   * `Expired`.
   */
  async listSent(query: ListSentInvitesQueryDto): Promise<PaginatedRows<ListedPartyInviteView>> {
    const userId = requireSessionUserId(this.auditContext.getActor());
    const now = new Date();

    const { rows, total } = await this.pageOf(
      {
        [InviteType.Household]: sentHouseholdInviteWhere(userId, now, query.status),
        [InviteType.Event]: sentEventInviteWhere(userId, now, query.status),
      },
      query,
    );

    return { rows: rows.map((row) => withEffectiveInviteStatus(row, now)), total };
  }

  /**
   * The acting user accepts an invite they received, by id or by the token
   * from its link. The responder for its type does the accepting, and the
   * answer says which type that was. One branch per kind, so each answer
   * carries the acceptance its own context made (#742), and a kind the party
   * routes serve without a branch here fails to compile.
   */
  async accept(target: InviteTarget): Promise<PartyAcceptance> {
    const inviteeId = requireSessionUserId(this.auditContext.getActor());
    const type = await this.inviteeTypeOf(target, inviteeId);

    switch (type) {
      case InviteType.Household:
        return { type, ...(await this.households.accept(target, inviteeId)) };

      case InviteType.Event:
        return { type, ...(await this.events.accept(target, inviteeId)) };
    }
  }

  /** The acting user declines an invite they received, by id or by the token from its link. */
  async decline(target: InviteTarget): Promise<InvitePartyView> {
    const inviteeId = requireSessionUserId(this.auditContext.getActor());
    const responder = this.responderFor(await this.inviteeTypeOf(target, inviteeId));

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
    const responder = this.responderFor(type);

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
   * The responder for an invite of this type: one for every kind the party
   * routes serve, so a kind added to them without its responder fails to
   * compile here, rather than meeting a 404 at runtime (#742). A kind they
   * don't serve never gets this far: the type read answers it the 404 a
   * stranger meets.
   */
  private responderFor(type: ContextualInviteType): PartyResponder {
    const responders = {
      [InviteType.Household]: this.households,
      [InviteType.Event]: this.events,
    } as const satisfies Record<ContextualInviteType, PartyResponder>;

    return responders[type];
  }

  /**
   * One page of a party's invites, newest first, and how many match in all.
   * `type` keeps one arm; without it, every kind's, in the order the kinds
   * are listed.
   *
   * REPEATABLE READ, so `total` and the rows come from one snapshot (#230).
   * `id` breaks ties on `createdAt`, so a row cannot cross a page boundary
   * between two requests.
   */
  private async pageOf(
    arms: PartyListArms,
    query: PaginationQueryDto & { readonly type?: ContextualInviteType },
  ): Promise<PaginatedRows<ListedPartyInviteView>> {
    const kinds: readonly ContextualInviteType[] = query.type === undefined ? CONTEXTUAL_INVITE_TYPES : [query.type];
    const where: Prisma.InviteWhereInput = { OR: kinds.map((kind) => arms[kind]) };

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
