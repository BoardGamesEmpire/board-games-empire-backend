import { InviteStatus, InviteType } from '@bge/database';
import { receivedEventInviteWhere } from './received-event-invites';

const INVITEE_ID = 'user-invitee';
const NOW = new Date('2026-11-25T12:00:00Z');

describe('receivedEventInviteWhere', () => {
  it("matches the user's open event invites by id, to a live event they don't attend (#742)", () => {
    expect(receivedEventInviteWhere(INVITEE_ID, NOW)).toEqual({
      type: InviteType.Event,
      AND: [
        // By id only, never one they sent: an event invite names its invitee
        // by id, so no address is vouched.
        { inviterId: { not: INVITEE_ID }, OR: [{ inviteeId: INVITEE_ID }] },
        { status: InviteStatus.Pending },
        { expiresAt: { gt: NOW } },
        {
          event: {
            is: {
              // Live as every event read judges it: not deleted, and not in a
              // deleted household, whose delete leaves its events' invites
              // open (#992).
              deletedAt: null,
              OR: [{ householdId: null }, { household: { is: { deletedAt: null } } }],
              // Accepting would seat them twice.
              attendees: { none: { userId: INVITEE_ID, removedAt: null } },
            },
          },
        },
      ],
    });
  });
});
