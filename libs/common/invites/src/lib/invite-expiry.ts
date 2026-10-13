import { InviteStatus, type Prisma } from '@bge/database';
import { OUTSTANDING_INVITE_STATUSES, type OutstandingInviteStatus } from './constants/invite.constants';

export function isOutstandingInviteStatus(status: InviteStatus): status is OutstandingInviteStatus {
  return (OUTSTANDING_INVITE_STATUSES as readonly InviteStatus[]).includes(status);
}

/** The two columns lazy expiry is decided from. */
export interface InviteExpiryFacts {
  readonly status: InviteStatus;
  readonly expiresAt: Date;
}

/**
 * The status an invite HAS, as opposed to the one its row still says.
 *
 * Expiry is lazy: nothing stamps `Expired` at the moment `expiresAt` passes.
 * A read computes it (this function), a transition that meets an expired row
 * persists it as its failure path (`InviteService`), and #165's sweep persists
 * whatever neither touched. Reads do not write through: a read that writes is a
 * surprise inside a consumer's read path, and the sweep converges the rows
 * regardless.
 *
 * Only an outstanding row can expire. A settled one keeps its status whatever
 * the clock says, so a declined invite past its date still reads `Declined`.
 */
export function effectiveInviteStatus(invite: InviteExpiryFacts, now: Date = new Date()): InviteStatus {
  return isOutstandingInviteStatus(invite.status) && invite.expiresAt <= now ? InviteStatus.Expired : invite.status;
}

/** The row with its `status` replaced by {@link effectiveInviteStatus}. */
export function withEffectiveInviteStatus<T extends InviteExpiryFacts>(invite: T, now: Date = new Date()): T {
  const status = effectiveInviteStatus(invite, now);

  return status === invite.status ? invite : { ...invite, status };
}

/**
 * The date half of "still open", as a `where` fragment a listing can filter
 * by: rows whose window has not closed at `now`. Pair it with a status
 * filter. {@link effectiveInviteStatus} calls a row at exactly `expiresAt`
 * expired, and this fragment agrees (`gt`, not `gte`), so a listing and a read
 * of the same row never disagree about whether it is live.
 */
export function unexpiredInviteWhere(now: Date = new Date()): Prisma.InviteWhereInput {
  return { expiresAt: { gt: now } };
}

/**
 * The query-side twin of {@link effectiveInviteStatus}: a `where` fragment
 * matching the rows whose status, as that function would compute it at `now`,
 * is `status`. Kept beside it so a listing filtered by status and a read of the
 * same row agree on the boundary.
 *
 * `Expired` matches the rows stamped so and the outstanding rows whose window
 * has closed. An outstanding status matches only the rows still inside their
 * window. A settled status matches its rows whatever the clock says.
 */
export function effectiveInviteStatusWhere(status: InviteStatus, now: Date = new Date()): Prisma.InviteWhereInput {
  if (status === InviteStatus.Expired) {
    return {
      OR: [
        { status: InviteStatus.Expired },
        { status: { in: [...OUTSTANDING_INVITE_STATUSES] }, expiresAt: { lte: now } },
      ],
    };
  }

  return isOutstandingInviteStatus(status) ? { status, ...unexpiredInviteWhere(now) } : { status };
}
