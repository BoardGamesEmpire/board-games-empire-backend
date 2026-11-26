import { InviteStatus, InviteType } from '@bge/database';
import { sentEventInviteWhere } from './sent-event-invites';

const INVITER_ID = 'user-inviter';
const NOW = new Date('2026-11-25T12:00:00Z');

/**
 * Where the inviter no longer attends, only what they can still withdraw: a
 * household owner's or admin's invites, sent without a seat on the event,
 * since being removed revoked a former attendee's (#742).
 */
const withdrawableOrStillAttending = {
  OR: [
    { event: { is: { attendees: { some: { userId: INVITER_ID, removedAt: null } } } } },
    { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] }, expiresAt: { gt: NOW } },
  ],
};

/**
 * The whole where for one status arm: the inviter's event invites, never to
 * an event that isn't live (#992), and only withdrawable ones where they no
 * longer attend.
 */
const sentWhere = (statusWhere: object) => ({
  type: InviteType.Event,
  inviterId: INVITER_ID,
  event: { is: { deletedAt: null, OR: [{ householdId: null }, { household: { is: { deletedAt: null } } }] } },
  AND: [statusWhere, withdrawableOrStillAttending],
});

describe('sentEventInviteWhere', () => {
  it("matches the user's outstanding and expired event invites by default (#742)", () => {
    expect(sentEventInviteWhere(INVITER_ID, NOW)).toEqual(
      sentWhere({ status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending, InviteStatus.Expired] } }),
    );
  });

  it('filters to any one status as it stands now (#742)', () => {
    expect(sentEventInviteWhere(INVITER_ID, NOW, InviteStatus.Expired)).toEqual(
      sentWhere({
        OR: [
          { status: InviteStatus.Expired },
          { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] }, expiresAt: { lte: NOW } },
        ],
      }),
    );
  });

  it("keeps a former attendee's settled invites out (#742)", () => {
    expect(sentEventInviteWhere(INVITER_ID, NOW, InviteStatus.Accepted)).toEqual(
      sentWhere({ status: InviteStatus.Accepted }),
    );
  });
});
