import { AuditContextService, requireSessionUserId } from '@bge/actor-context';
import { DatabaseService, InviteType, Prisma } from '@bge/database';
import {
  OUTSTANDING_INVITE_STATUSES,
  PARTY_INVITE_SELECT,
  receivedInviteWhere,
  unexpiredInviteWhere,
} from '@bge/invites';
import { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { Injectable } from '@nestjs/common';

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

/**
 * The invitee's side of a household invite (#163): the invites they have
 * received. The household's side, creating and listing a household's
 * invites, is `HouseholdInviteService`.
 *
 * No CASL rule stands behind it: an invitee holds no grant on `Invite`, and
 * needs none, because `@bge/invites` binds every party read to the acting
 * user in the query (#161). What this service adds is whose address may stand
 * in for that binding, and who the acting user may be: only a person signed in
 * as themself, since joining a household is the joiner's own act (#276). An
 * API key acts for its owner but is not the owner, neither a plugin nor the
 * system joins anyone, and no invite by id can name an anonymous guest.
 */
@Injectable()
export class PartyInviteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditContext: AuditContextService,
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
