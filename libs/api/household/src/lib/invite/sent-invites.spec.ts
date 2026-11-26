import { InviteStatus, InviteType } from '@bge/database';
import { sentHouseholdInviteWhere } from './sent-invites';

const INVITER_ID = 'user-inviter';
const NOW = new Date('2026-10-15T12:00:00Z');

/**
 * Where the inviter is not a household member, only what they can still
 * withdraw: a server owner's invites, since leaving revoked a former household
 * member's (#747).
 */
const withdrawableOrStillMember = {
  OR: [
    { household: { is: { members: { some: { userId: INVITER_ID } } } } },
    { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] }, expiresAt: { gt: NOW } },
  ],
};

/**
 * The whole where for one status arm: the inviter's household invites, never
 * into a deleted household (the delete revoked them), and only withdrawable
 * ones where the inviter is no longer a household member (#747).
 */
const sentWhere = (statusWhere: object) => ({
  type: InviteType.Household,
  inviterId: INVITER_ID,
  household: { is: { deletedAt: null } },
  AND: [statusWhere, withdrawableOrStillMember],
});

describe('sentHouseholdInviteWhere', () => {
  it("matches the user's outstanding and expired household invites by default (#751)", () => {
    expect(sentHouseholdInviteWhere(INVITER_ID, NOW)).toEqual(
      // Expired whether or not the sweep has stamped it, so the inviter sees
      // it lapse and can send another.
      sentWhere({ status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending, InviteStatus.Expired] } }),
    );
  });

  it('filters to any one status as it stands now (#751)', () => {
    expect(sentHouseholdInviteWhere(INVITER_ID, NOW, InviteStatus.Expired)).toEqual(
      sentWhere({
        OR: [
          { status: InviteStatus.Expired },
          { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] }, expiresAt: { lte: NOW } },
        ],
      }),
    );
  });

  it("keeps a former member's settled invites out (#747)", () => {
    // Whatever the filter asks, only withdrawable rows where they left.
    expect(sentHouseholdInviteWhere(INVITER_ID, NOW, InviteStatus.Accepted)).toEqual(
      sentWhere({ status: InviteStatus.Accepted }),
    );
  });
});
