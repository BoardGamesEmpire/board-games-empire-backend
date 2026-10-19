import { MemberInvitePolicy, NotificationType, SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import type { UnreadNotificationWire } from '../notification/notification-wire';
import { unreadWhen } from '../notification/unread-poll';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { inviteEnvelope } from './household-invite-wire';
import { createMemberClient } from './household-request';

type Unread = readonly UnreadNotificationWire[];

/**
 * The household notifications, driven over HTTP and read back through
 * `GET /api/notifications/unread`:
 *
 * - an invite tells its invitee exactly when their inbox (`GET /api/invites`)
 *   would list it, and one awaiting approval tells the household owners and
 *   admins instead (#167);
 * - an accept tells the household's members, and a decline tells the inviter
 *   and the household owners and admins (#682);
 * - a transfer of household ownership tells the new household owner (#246).
 *
 * The listener runs after the response to the request that caused it, so each
 * test polls for what it expects. Where a user must NOT be told, the test sends
 * them a later notification and waits for that one before checking: a fixed
 * sleep would pass as well if the listener never ran.
 *
 * Actors and rosters are arranged before any of them sends a request, as in
 * `household-invites.spec.ts`: the API caches each user's ability on first use
 * and this process cannot evict it (#256).
 */
describe('household notifications', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { transferOwnership } = createMemberClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const createdInvite = async (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(
      await request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body).expect(201),
      'POST /api/households/:id/invites',
    ).invite;

  const approve = (actor: SessionActor, householdId: string, inviteId: string) =>
    request(baseUrl).post(`/api/households/${householdId}/invites/${inviteId}/approve`).set(actor.headers);

  const accept = (actor: SessionActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/accept`).set(actor.headers);

  const decline = (actor: SessionActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/decline`).set(actor.headers);

  const verify = (actor: SessionActor) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { emailVerified: true } });

  /** A user's display name, or their username when it is unset or blank: how a notification names them. */
  const nameOf = async (actor: SessionActor) => {
    const profile = await db.client.userProfile.findUnique({ where: { userId: actor.user.id } });

    return profile?.displayName || actor.user.username;
  };

  const unread = (actor: SessionActor, predicate: (unread: Unread) => boolean) => unreadWhen(baseUrl, actor, predicate);

  /** The notifications of one type, about one invite. */
  const about = (list: Unread, type: NotificationType, inviteId: string) =>
    list.filter((notification) => notification.type === type && notification.payload['inviteId'] === inviteId);

  const holds = (type: NotificationType, inviteId: string) => (list: Unread) => about(list, type, inviteId).length > 0;

  describe('an invite (#167)', () => {
    it('an existing user invited by id is told (#167)', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });

      const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

      const received = await unread(invitee, holds(NotificationType.HouseholdInviteReceived, invite.id));

      // Exactly these keys: the invitee's notification never carries an address.
      expect(about(received, NotificationType.HouseholdInviteReceived, invite.id)).toEqual([
        expect.objectContaining({
          payload: {
            householdId: household.id,
            householdName: household.name,
            inviteId: invite.id,
            inviterName: await nameOf(owner),
          },
        }),
      ]);
    });

    it('a user invited at their verified address is told; one at an unverified address is not (#167)', async () => {
      const [owner, verified, unverified] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      await verify(verified);

      const toVerified = await createdInvite(owner, household.id, { inviteeEmail: verified.user.email });
      const toUnverified = await createdInvite(owner, household.id, { inviteeEmail: unverified.user.email });
      // Their inbox lists an invite by id whatever their address, so this one
      // tells them, and is the notification waited for.
      const sentinel = await createdInvite(owner, household.id, { inviteeId: unverified.user.id });

      const received = await unread(verified, holds(NotificationType.HouseholdInviteReceived, toVerified.id));
      const told = await unread(unverified, holds(NotificationType.HouseholdInviteReceived, sentinel.id));

      // Sent to an address, and still without it.
      expect(about(received, NotificationType.HouseholdInviteReceived, toVerified.id)).toEqual([
        expect.objectContaining({
          payload: {
            householdId: household.id,
            householdName: household.name,
            inviteId: toVerified.id,
            inviterName: await nameOf(owner),
          },
        }),
      ]);

      expect(told.map((notification) => notification.payload['inviteId'])).toEqual([sentinel.id]);
      expect(about(told, NotificationType.HouseholdInviteReceived, toUnverified.id)).toEqual([]);
    });

    it('a member invited at their own verified address is not told: their inbox does not list it (#167)', async () => {
      const [owner, member, newcomer] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      await verify(member);

      const toMember = await createdInvite(owner, household.id, { inviteeEmail: member.user.email });
      const sentinel = await createdInvite(owner, household.id, { inviteeId: newcomer.user.id });
      await accept(newcomer, sentinel.id).expect(200);

      const told = await unread(member, holds(NotificationType.HouseholdInviteAccepted, sentinel.id));

      expect(told.map((notification) => notification.type)).toEqual([NotificationType.HouseholdInviteAccepted]);
      expect(about(told, NotificationType.HouseholdInviteReceived, toMember.id)).toEqual([]);
    });

    it('an invite awaiting approval tells household owners and admins, and its invitee only once approved (#167)', async () => {
      const [owner, admin, member, invitee, elsewhereOwner] = await Promise.all(
        Array.from({ length: 5 }, () => actors.user()),
      );
      const { household } = await actors.householdWithMembers({
        owner,
        members: [
          { actor: admin, role: SystemRole.HouseholdAdmin },
          { actor: member, role: SystemRole.HouseholdMember },
        ],
        memberInvitePolicy: MemberInvitePolicy.NeedsApproval,
      });
      const { household: elsewhere } = await actors.householdWithMembers({ owner: elsewhereOwner });

      const invite = await createdInvite(member, household.id, { inviteeId: invitee.user.id });
      const inviterName = await nameOf(member);

      // Who becomes a member is theirs to answer for, so they see the invitee
      // as the invite names them: the user, since it was sent by id, and no
      // address.
      for (const approver of [owner, admin]) {
        const waiting = await unread(approver, holds(NotificationType.HouseholdInviteAwaitingApproval, invite.id));

        expect(about(waiting, NotificationType.HouseholdInviteAwaitingApproval, invite.id)).toEqual([
          expect.objectContaining({
            payload: {
              householdId: household.id,
              householdName: household.name,
              inviteId: invite.id,
              inviterName,
              inviteeId: invitee.user.id,
              inviteeName: invite.inviteeName,
              inviteeEmail: null,
            },
          }),
        ]);
      }

      // An invite from another household tells the invitee, and is the
      // notification waited for: nothing reached them while the invite waited.
      // It comes from elsewhere because a household holds one open invite per
      // invitee.
      const sentinel = await createdInvite(elsewhereOwner, elsewhere.id, { inviteeId: invitee.user.id });
      const whileWaiting = await unread(invitee, holds(NotificationType.HouseholdInviteReceived, sentinel.id));

      expect(whileWaiting.map((notification) => notification.payload['inviteId'])).toEqual([sentinel.id]);

      await approve(admin, household.id, invite.id).expect(200);

      // The approval tells them.
      const told = await unread(invitee, holds(NotificationType.HouseholdInviteReceived, invite.id));

      expect(about(told, NotificationType.HouseholdInviteReceived, invite.id)).toEqual([
        expect.objectContaining({
          payload: { householdId: household.id, householdName: household.name, inviteId: invite.id, inviterName },
        }),
      ]);
    });
  });

  describe('an accept or a decline (#682)', () => {
    it('an accept tells every member but the new member (#682)', async () => {
      const [owner, admin, member, guest, newcomer, later] = await Promise.all(
        Array.from({ length: 6 }, () => actors.user()),
      );
      const { household } = await actors.householdWithMembers({
        owner,
        members: [
          { actor: admin, role: SystemRole.HouseholdAdmin },
          { actor: member, role: SystemRole.HouseholdMember },
          { actor: guest, role: SystemRole.HouseholdGuest },
        ],
      });
      const invite = await createdInvite(owner, household.id, { inviteeId: newcomer.user.id });
      const laterInvite = await createdInvite(owner, household.id, { inviteeId: later.user.id });

      await accept(newcomer, invite.id).expect(200);

      const memberName = await nameOf(newcomer);
      for (const told of [owner, admin, member, guest]) {
        const list = await unread(told, holds(NotificationType.HouseholdInviteAccepted, invite.id));

        // A name, and never an address.
        expect(about(list, NotificationType.HouseholdInviteAccepted, invite.id)).toEqual([
          expect.objectContaining({
            payload: {
              householdId: household.id,
              householdName: household.name,
              inviteId: invite.id,
              memberUserId: newcomer.user.id,
              memberName,
            },
          }),
        ]);
      }

      // The new member is a member now, so the next accept tells them, and is
      // the notification waited for.
      await accept(later, laterInvite.id).expect(200);
      const newcomers = await unread(newcomer, holds(NotificationType.HouseholdInviteAccepted, laterInvite.id));

      expect(about(newcomers, NotificationType.HouseholdInviteAccepted, invite.id)).toEqual([]);
    });

    it('a decline tells the inviter and the household owners and admins once each, and a decline by address names no user (#682)', async () => {
      const [owner, admin, member, byIdInvitee, byAddressInvitee] = await Promise.all(
        Array.from({ length: 5 }, () => actors.user()),
      );
      const { household } = await actors.householdWithMembers({
        owner,
        members: [
          { actor: admin, role: SystemRole.HouseholdAdmin },
          { actor: member, role: SystemRole.HouseholdMember },
        ],
        memberInvitePolicy: MemberInvitePolicy.Direct,
      });
      await verify(byAddressInvitee);

      // The household admin sent this one, so they are told as its inviter and
      // as a household admin, and must be told once.
      const byId = await createdInvite(admin, household.id, { inviteeId: byIdInvitee.user.id });
      const byAddress = await createdInvite(member, household.id, { inviteeEmail: byAddressInvitee.user.email });

      await decline(byIdInvitee, byId.id).expect(200);
      // Declining binds the user to an invite by address; the notification
      // still names the invitee as the invite did.
      await decline(byAddressInvitee, byAddress.id).expect(200);

      const declinedById = {
        householdId: household.id,
        householdName: household.name,
        inviteId: byId.id,
        inviteeId: byIdInvitee.user.id,
        inviteeName: byId.inviteeName,
        inviteeEmail: null,
      };
      const declinedByAddress = {
        householdId: household.id,
        householdName: household.name,
        inviteId: byAddress.id,
        inviteeId: null,
        inviteeName: byAddress.inviteeName,
        inviteeEmail: byAddress.inviteeEmail,
      };

      const holdsBoth = (current: Unread) =>
        holds(NotificationType.HouseholdInviteDeclined, byId.id)(current) &&
        holds(NotificationType.HouseholdInviteDeclined, byAddress.id)(current);

      for (const authority of [owner, admin]) {
        const list = await unread(authority, holdsBoth);

        expect(about(list, NotificationType.HouseholdInviteDeclined, byId.id)).toEqual([
          expect.objectContaining({ payload: declinedById }),
        ]);
        expect(about(list, NotificationType.HouseholdInviteDeclined, byAddress.id)).toEqual([
          expect.objectContaining({ payload: declinedByAddress }),
        ]);
      }

      // The member is told of the invite they sent, and not of the one they
      // neither sent nor answer for.
      const members = await unread(member, holds(NotificationType.HouseholdInviteDeclined, byAddress.id));

      expect(members).toEqual([expect.objectContaining({ payload: declinedByAddress })]);
    });

    it('a repeated accept or decline creates no second notification (#682)', async () => {
      const [owner, accepting, declining, last] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({ owner });
      const accepted = await createdInvite(owner, household.id, { inviteeId: accepting.user.id });
      const declined = await createdInvite(owner, household.id, { inviteeId: declining.user.id });
      const sentinel = await createdInvite(owner, household.id, { inviteeId: last.user.id });

      await accept(accepting, accepted.id).expect(200);
      await accept(accepting, accepted.id).expect(409);
      await decline(declining, declined.id).expect(200);
      await decline(declining, declined.id).expect(409);
      // Each repeat is followed by a notification to the same household owner,
      // and all three are waited for.
      await decline(last, sentinel.id).expect(200);

      const list = await unread(
        owner,
        (current) =>
          holds(NotificationType.HouseholdInviteAccepted, accepted.id)(current) &&
          holds(NotificationType.HouseholdInviteDeclined, declined.id)(current) &&
          holds(NotificationType.HouseholdInviteDeclined, sentinel.id)(current),
      );

      expect(about(list, NotificationType.HouseholdInviteAccepted, accepted.id)).toHaveLength(1);
      expect(about(list, NotificationType.HouseholdInviteDeclined, declined.id)).toHaveLength(1);
    });
  });

  describe('a transfer of household ownership (#246)', () => {
    it('a transfer tells the new household owner (#246)', async () => {
      const [owner, heir] = await Promise.all([actors.user(), actors.user()]);
      const fixture = await actors.householdWithMembers({
        owner,
        members: [{ actor: heir, role: SystemRole.HouseholdMember }],
      });
      const { household } = fixture;
      const ownerMemberId = fixture.owner.member.id;
      const heirMemberId = fixture.members[0].member.id;
      const [ownerName, heirName] = await Promise.all([nameOf(owner), nameOf(heir)]);

      await transferOwnership(owner, household.id, heirMemberId).expect(200);

      const isTransfer = (list: Unread) =>
        list.some((notification) => notification.type === NotificationType.HouseholdOwnershipTransferred);
      const heirs = await unread(heir, isTransfer);

      expect(heirs).toEqual([
        expect.objectContaining({
          type: NotificationType.HouseholdOwnershipTransferred,
          payload: {
            householdId: household.id,
            householdName: household.name,
            previousOwnerMemberId: ownerMemberId,
            previousOwnerName: ownerName,
            newOwnerMemberId: heirMemberId,
            newOwnerName: heirName,
          },
        }),
      ]);

      // The previous household owner made the transfer and is not told of it.
      // Handing the household back tells them, and is the notification waited
      // for.
      await transferOwnership(heir, household.id, ownerMemberId).expect(200);
      const owners = await unread(owner, isTransfer);

      expect(owners).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ previousOwnerMemberId: heirMemberId, newOwnerMemberId: ownerMemberId }),
        }),
      ]);
    });
  });
});
