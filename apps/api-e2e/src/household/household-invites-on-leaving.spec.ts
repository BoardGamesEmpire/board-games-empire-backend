import { InviteStatus, MemberInvitePolicy, SystemRole } from '@bge/database';
import { arrangeInvite, createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { acceptEnvelope, inviteEnvelope } from './household-invite-wire';
import { createMemberClient } from './household-request';

/**
 * What happens to a household's invites when a member leaves or is removed,
 * and what accepting one asks of its sender (#747).
 *
 * - Leaving and being removed revoke, in the same transaction, the outstanding
 *   invites the member sent and the invites that name them by id.
 * - Invites to their address stay open when they leave or are removed:
 *   revoking those would tell each inviter whose address it was. A household
 *   ban (#782) is what closes them, by withholding them.
 * - Accepting an invite asks whether its sender could still send it now, with
 *   the role it offers. If not, the invite is revoked, and the invitee meets
 *   the 409 a revoked invite gets.
 *
 * Actors and rosters are arranged before any of them sends a request, as in
 * `household-invites.spec.ts`: the API caches each user's ability on first use
 * and this process cannot evict it (#256).
 */
describe('household invites when a member leaves, and the sender check at accept (#747)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const { removeMember, leave, transferOwnership, changeRole } = createMemberClient(baseUrl);

  const accept = (actor: AuthenticatedActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/accept`).set(actor.headers);

  const createdInvite = async (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(
      await request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body).expect(201),
      'POST /api/households/:id/invites',
    ).invite;

  const approve = (actor: SessionActor, householdId: string, inviteId: string) =>
    request(baseUrl).post(`/api/households/${householdId}/invites/${inviteId}/approve`).set(actor.headers);

  const setMemberInvitePolicy = (actor: SessionActor, householdId: string, memberInvitePolicy: MemberInvitePolicy) =>
    request(baseUrl)
      .patch(`/api/households/${householdId}`)
      .set(actor.headers)
      .send({ settings: { memberInvitePolicy } });

  const storedInvite = (id: string) => db.client.invite.findUniqueOrThrow({ where: { id } });

  const membership = (householdId: string, userId: string) =>
    db.client.householdMember.findUnique({ where: { householdId_userId: { householdId, userId } } });

  const verify = (actor: SessionActor) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { emailVerified: true } });

  /** The message a refusal carries, so a surprise reads as a diff rather than as a bare status. */
  const messageOf = (response: { body: unknown }) => (response.body as { message?: unknown } | null)?.message;

  /** The refusal a revoked invite gets, which is all an invitee learns whatever revoked it. */
  const expectRevokedRefusal = async (response: request.Response, inviteId: string) => {
    expect(messageOf(response)).toContain(InviteStatus.Revoked);
    await expect(storedInvite(inviteId)).resolves.toMatchObject({ status: InviteStatus.Revoked });
  };

  /** A household with an owner, an admin and a member, under `memberInvitePolicy`. */
  const household = async (memberInvitePolicy?: MemberInvitePolicy) => {
    const [owner, admin, member] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    const { household: created, members } = await actors.householdWithMembers({
      owner,
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        { actor: member, role: SystemRole.HouseholdMember },
      ],
      memberInvitePolicy,
    });

    return {
      householdId: created.id,
      owner,
      admin,
      member,
      adminMemberId: members[0].member.id,
      memberMemberId: members[1].member.id,
    };
  };

  /** How the member departs: an owner removes them, or they leave. */
  const departures = [
    ['removed', (h: Awaited<ReturnType<typeof household>>) => removeMember(h.owner, h.householdId, h.memberMemberId)],
    ['leaves', (h: Awaited<ReturnType<typeof household>>) => leave(h.member, h.householdId)],
  ] as const;

  describe('invites to the departing member', () => {
    it.each(departures)(
      'revokes one by id when the member is %s, and leaves one to their address open',
      async (_how, depart) => {
        const h = await household();
        await verify(h.member);
        // An invite by id to a current member can't be made through the route;
        // it is the one left over from before they joined by another invite.
        const byId = await arrangeInvite(db.client, {
          inviter: h.owner,
          householdId: h.householdId,
          inviteeId: h.member.user.id,
        });
        // An address may be invited whoever holds it, a member included.
        const byAddress = await createdInvite(h.admin, h.householdId, { inviteeEmail: h.member.user.email });

        await depart(h).expect(200);

        await expectRevokedRefusal(await accept(h.member, byId.id).expect(409), byId.id);
        await expect(membership(h.householdId, h.member.user.id)).resolves.toBeNull();

        // Open on purpose: leaving or being removed leaves an address invite
        // open, and a household ban (#782) is what closes it.
        await expect(storedInvite(byAddress.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
        acceptEnvelope(await accept(h.member, byAddress.id).expect(200), 'POST /api/invites/:id/accept');
        await expect(membership(h.householdId, h.member.user.id)).resolves.not.toBeNull();
      },
    );
  });

  describe('invites the departing member sent', () => {
    it.each(departures)(
      'revokes the ones still open and waiting for approval when the member is %s, and no one else’s',
      async (_how, depart) => {
        const h = await household(MemberInvitePolicy.NeedsApproval);
        const [waitingInvitee, openInvitee, ownersInvitee] = await Promise.all([
          actors.user(),
          actors.user(),
          actors.user(),
        ]);
        const waiting = await createdInvite(h.member, h.householdId, { inviteeId: waitingInvitee.user.id });
        const open = await createdInvite(h.member, h.householdId, { inviteeId: openInvitee.user.id });
        await approve(h.owner, h.householdId, open.id).expect(200);
        const owners = await createdInvite(h.owner, h.householdId, { inviteeId: ownersInvitee.user.id });

        // A control: what the member sent was outstanding before they went.
        expect(waiting.status).toBe(InviteStatus.AwaitingApproval);
        await expect(storedInvite(open.id)).resolves.toMatchObject({ status: InviteStatus.Pending });

        await depart(h).expect(200);

        await expect(storedInvite(waiting.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
        await expectRevokedRefusal(await accept(openInvitee, open.id).expect(409), open.id);
        await expect(membership(h.householdId, openInvitee.user.id)).resolves.toBeNull();

        await expect(storedInvite(owners.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
      },
    );

    it("revokes an admin's invites when an owner removes the admin", async () => {
      const h = await household();
      const invitee = await actors.user();
      const invite = await createdInvite(h.admin, h.householdId, { inviteeId: invitee.user.id });

      await removeMember(h.owner, h.householdId, h.adminMemberId).expect(200);

      await expectRevokedRefusal(await accept(invitee, invite.id).expect(409), invite.id);
    });
  });

  describe('accepting asks whether the sender could still send the invite', () => {
    it('revokes an invite offering the admin role once its sender has handed over ownership (#169)', async () => {
      const h = await household();
      const invitee = await actors.user();
      const invite = await createdInvite(h.owner, h.householdId, {
        inviteeId: invitee.user.id,
        role: SystemRole.HouseholdAdmin,
      });

      // The owner becomes a household admin, who can't offer the admin role (#168).
      await transferOwnership(h.owner, h.householdId, h.adminMemberId).expect(200);

      await expectRevokedRefusal(await accept(invitee, invite.id).expect(409), invite.id);
      await expect(membership(h.householdId, invitee.user.id)).resolves.toBeNull();
    });

    it.each([MemberInvitePolicy.Off, MemberInvitePolicy.NeedsApproval])(
      "revokes a member's invite opened directly once the policy becomes %s",
      async (tightened) => {
        const h = await household(MemberInvitePolicy.Direct);
        const invitee = await actors.user();
        const invite = await createdInvite(h.member, h.householdId, { inviteeId: invitee.user.id });
        expect(invite.status).toBe(InviteStatus.Pending);

        await setMemberInvitePolicy(h.owner, h.householdId, tightened).expect(200);

        // Under NeedsApproval the member could still send it for approval, but
        // this one never waited for an approver.
        await expectRevokedRefusal(await accept(invitee, invite.id).expect(409), invite.id);
        await expect(membership(h.householdId, invitee.user.id)).resolves.toBeNull();
      },
    );

    it('accepts an approved invite its sender could still send for approval', async () => {
      const h = await household(MemberInvitePolicy.NeedsApproval);
      const invitee = await actors.user();
      const invite = await createdInvite(h.member, h.householdId, { inviteeId: invitee.user.id });
      await approve(h.admin, h.householdId, invite.id).expect(200);

      acceptEnvelope(await accept(invitee, invite.id).expect(200), 'POST /api/invites/:id/accept');

      await expect(membership(h.householdId, invitee.user.id)).resolves.toMatchObject({
        addedById: h.member.user.id,
      });
    });

    it('accepts an invite whose sender has been promoted since', async () => {
      const h = await household(MemberInvitePolicy.Direct);
      const invitee = await actors.user();
      const invite = await createdInvite(h.member, h.householdId, { inviteeId: invitee.user.id });

      await changeRole(h.owner, h.householdId, h.memberMemberId, SystemRole.HouseholdAdmin).expect(200);

      acceptEnvelope(await accept(invitee, invite.id).expect(200), 'POST /api/invites/:id/accept');
      await expect(membership(h.householdId, invitee.user.id)).resolves.not.toBeNull();
    });

    it('revokes an invite whose sender is under a ban, as they could send nothing now', async () => {
      const h = await household();
      const invitee = await actors.user();
      const invite = await createdInvite(h.admin, h.householdId, { inviteeId: invitee.user.id });

      // Banned and still a member: nothing on the roster changed.
      await db.client.user.update({ where: { id: h.admin.user.id }, data: { banned: true } });

      await expectRevokedRefusal(await accept(invitee, invite.id).expect(409), invite.id);
      await expect(membership(h.householdId, invitee.user.id)).resolves.toBeNull();
    });

    it('answers someone already a member as already a member, and revokes nothing', async () => {
      const h = await household(MemberInvitePolicy.Direct);
      // An address may be invited whoever holds it, a member included.
      const invite = await createdInvite(h.member, h.householdId, { inviteeEmail: h.admin.user.email });
      await setMemberInvitePolicy(h.owner, h.householdId, MemberInvitePolicy.Off).expect(200);
      await verify(h.admin);

      const response = await accept(h.admin, invite.id).expect(409);

      // Revoking would tell the member that the address belongs to someone in
      // the household.
      expect(messageOf(response)).toContain('already a member');
      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    });
  });
});
