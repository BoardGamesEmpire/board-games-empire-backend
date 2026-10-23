import { InviteStatus, ResourceType, SystemRole } from '@bge/database';
import { arrangeInvite, createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { inviteEnvelope, receivedInvitesEnvelope, revokeEnvelope } from './household-invite-wire';
import { createMemberClient } from './household-request';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Ending an invite before it is accepted (#164), three ways:
 *
 * - the invitee declines: `POST /api/invites/:inviteId/decline`, or
 *   `POST /api/invites/decline` with the token from its link in the body;
 * - the inviter withdraws: `POST /api/invites/:inviteId/withdraw`, whatever
 *   their role in the household now. Once they leave it there is nothing to
 *   withdraw, since leaving revoked it (#747);
 * - an Owner or Admin revokes an invite someone else sent:
 *   `POST /api/households/:householdId/invites/:inviteId/revoke`.
 *
 * Withdraw and revoke never stand in for each other: the inviter is refused at
 * revoke, and only the inviter withdraws.
 *
 * Actors and rosters are arranged before any of them sends a request, as in
 * `household-invites.spec.ts`: the API caches each user's ability on first use
 * and this process cannot evict it (#256).
 */
describe('declining, withdrawing and revoking a household invite', () => {
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

  const declineById = (actor: Caller, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/decline`).set(actor.headers);

  const declineByToken = (actor: Caller, token: unknown) =>
    request(baseUrl).post('/api/invites/decline').set(actor.headers).send({ token });

  const withdraw = (actor: Caller, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/withdraw`).set(actor.headers);

  const revoke = (actor: Caller, householdId: string, inviteId: string) =>
    request(baseUrl).post(`/api/households/${householdId}/invites/${inviteId}/revoke`).set(actor.headers);

  const { removeMember, changeRole } = createMemberClient(baseUrl);

  const createdInvite = async (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(
      await request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body).expect(201),
      'POST /api/households/:id/invites',
    ).invite;

  const inbox = async (actor: AuthenticatedActor) =>
    receivedInvitesEnvelope(
      await request(baseUrl).get('/api/invites').set(actor.headers).expect(200),
      'GET /api/invites',
    ).invites;

  const storedInvite = (id: string) => db.client.invite.findUniqueOrThrow({ where: { id } });

  const verify = (actor: SessionActor) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { emailVerified: true } });

  /** A key its owner minted, scoped to the given grants on `Invite`, or on the one invite `resourceId` names. */
  const inviteKey = (owner: SessionActor, slugs: readonly string[], resourceId?: string) =>
    mintApiKey(baseUrl, db.client, owner, { slugs, resourceType: ResourceType.Invite, resourceId });

  /** The message a refusal carries, so a surprise reads as a diff rather than as a bare status. */
  const messageOf = (response: { body: unknown }) => (response.body as { message?: unknown } | null)?.message;

  describe('declining', () => {
    it('declines by id, settling the invite and dropping it from the inbox', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

      const declined = inviteEnvelope(
        await declineById(invitee, invite.id).expect(200),
        'POST /api/invites/:id/decline',
      );

      expect(declined.invite).toMatchObject({ id: invite.id, status: InviteStatus.Declined });
      expect(declined.invite).not.toHaveProperty('token');
      await expect(storedInvite(invite.id)).resolves.toMatchObject({
        status: InviteStatus.Declined,
        respondedAt: expect.any(Date),
      });
      await expect(inbox(invitee)).resolves.toEqual([]);
      expect(await db.client.householdMember.count({ where: { householdId: household.id } })).toBe(1);
    });

    it('declines by the token in the body, and by the id of an invite to a verified address', async () => {
      const [owner, linkHolder, addressHolder] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      await verify(addressHolder);
      const byLink = await createdInvite(owner, household.id, { inviteeEmail: `link-${randomUUID()}@e2e.invalid` });
      const byAddress = await createdInvite(owner, household.id, { inviteeEmail: addressHolder.user.email });
      const { token } = await storedInvite(byLink.id);

      await declineByToken(linkHolder, token).expect(200);
      await declineById(addressHolder, byAddress.id).expect(200);

      // Each decline binds the invite to the account that answered it, as an accept does.
      await expect(storedInvite(byLink.id)).resolves.toMatchObject({
        status: InviteStatus.Declined,
        inviteeId: linkHolder.user.id,
      });
      await expect(storedInvite(byAddress.id)).resolves.toMatchObject({
        status: InviteStatus.Declined,
        inviteeId: addressHolder.user.id,
      });
    });

    it('declines an invite still awaiting approval: a refusal never waits on an approver', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const invite = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: household.id,
        inviteeId: invitee.user.id,
        status: InviteStatus.AwaitingApproval,
      });

      await declineById(invitee, invite.id).expect(200);

      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Declined });
    });

    it("settles a member's leftover invite, which accept refuses, and leaves their role as it was", async () => {
      const [owner, member] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdGuest }],
      });
      await verify(member);
      // An invite to a member's address stays open when their accept is refused
      // (#163), and decline is how they settle it.
      const invite = await createdInvite(owner, household.id, {
        inviteeEmail: member.user.email,
        role: SystemRole.HouseholdAdmin,
      });
      await request(baseUrl).post(`/api/invites/${invite.id}/accept`).set(member.headers).expect(409);

      await declineById(member, invite.id).expect(200);

      await expect(storedInvite(invite.id)).resolves.toMatchObject({
        status: InviteStatus.Declined,
        inviteeId: member.user.id,
      });
      const role = await db.client.householdRole.findFirstOrThrow({
        where: { householdMember: { householdId: household.id, userId: member.user.id } },
        select: { role: { select: { name: true } } },
      });
      expect(role.role.name).toBe(SystemRole.HouseholdGuest);
    });

    it('answers 404 for a stranger, an unverified address and a withheld invite, and 403 for the inviter', async () => {
      const [owner, invitee, stranger, unverified, blocked] = await Promise.all(
        Array.from({ length: 5 }, () => actors.user()),
      );
      const { household } = await actors.householdWithMembers({ owner });
      await verify(blocked);
      const toInvitee = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });
      const toUnverified = await createdInvite(owner, household.id, { inviteeEmail: unverified.user.email });
      const withheld = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: household.id,
        inviteeEmail: blocked.user.email,
        withheld: true,
      });

      await declineById(stranger, toInvitee.id).expect(404);
      await declineByToken(stranger, `not-a-token-${randomUUID()}`).expect(404);
      await declineById(unverified, toUnverified.id).expect(404);
      await declineById(blocked, withheld.id).expect(404);
      await declineByToken(blocked, withheld.token).expect(404);
      await declineById(owner, toInvitee.id).expect(403);

      const statuses = await db.client.invite.findMany({
        where: { householdId: household.id },
        select: { status: true },
      });
      expect(statuses.map(({ status }) => status)).toEqual([
        InviteStatus.Pending,
        InviteStatus.Pending,
        InviteStatus.Pending,
      ]);
    });

    it('answers 410 for an expired invite and 409 for a settled one', async () => {
      const [owner, lapsed, withdrawn] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const expired = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: household.id,
        inviteeId: lapsed.user.id,
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      const settled = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: household.id,
        inviteeId: withdrawn.user.id,
        status: InviteStatus.Withdrawn,
      });

      await declineById(lapsed, expired.id).expect(410);
      const refused = await declineById(withdrawn, settled.id).expect(409);

      expect(messageOf(refused)).toContain(InviteStatus.Withdrawn);
    });

    it('refuses with 400 a body with no token', async () => {
      const actor = await actors.user();

      await declineByToken(actor, undefined).expect(400);
    });
  });

  describe('withdrawing', () => {
    it('withdraws an invite its inviter sent, in the party shape', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id, message: 'Join us' });

      const withdrawn = inviteEnvelope(await withdraw(owner, invite.id).expect(200), 'POST /api/invites/:id/withdraw');

      expect(withdrawn.invite).toMatchObject({ id: invite.id, status: InviteStatus.Withdrawn, message: 'Join us' });
      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Withdrawn });
      await expect(inbox(invitee)).resolves.toEqual([]);
    });

    it('lets an inviter withdraw after they have been demoted', async () => {
      const [owner, admin, invitee] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household, members } = await actors.householdWithMembers({
        owner,
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const invite = await createdInvite(admin, household.id, { inviteeId: invitee.user.id });

      await changeRole(owner, household.id, members[0].member.id, SystemRole.HouseholdGuest).expect(200);

      await withdraw(admin, invite.id).expect(200);

      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Withdrawn });
    });

    it('leaves a removed inviter nothing to withdraw: being removed revoked it (#747)', async () => {
      const [owner, admin, invitee] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household, members } = await actors.householdWithMembers({
        owner,
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const invite = await createdInvite(admin, household.id, { inviteeId: invitee.user.id });

      await removeMember(owner, household.id, members[0].member.id).expect(200);

      const refused = await withdraw(admin, invite.id).expect(409);

      expect(messageOf(refused)).toContain(InviteStatus.Revoked);
      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
    });

    it('answers 403 for the invitee and 404 for a stranger, an Owner who did not send it among them', async () => {
      const [owner, admin, invitee, stranger] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const invite = await createdInvite(admin, household.id, { inviteeId: invitee.user.id });

      await withdraw(invitee, invite.id).expect(403);
      await withdraw(stranger, invite.id).expect(404);
      // Authority over the household is revoke's; withdraw answers to the inviter alone.
      await withdraw(owner, invite.id).expect(404);

      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    });

    it('answers 410 for an expired invite and 409 for a settled one', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const expired = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: household.id,
        inviteeId: invitee.user.id,
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      const declined = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: household.id,
        inviteeEmail: `declined-${randomUUID()}@e2e.invalid`,
        status: InviteStatus.Declined,
      });

      await withdraw(owner, expired.id).expect(410);
      await withdraw(owner, declined.id).expect(409);
    });
  });

  describe('revoking', () => {
    it("lets a household admin revoke the household owner's invite and the owner revoke the admin's, with the address and without the message (#167)", async () => {
      const [owner, admin, first] = await Promise.all(Array.from({ length: 3 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const ownersInvite = await createdInvite(owner, household.id, { inviteeId: first.user.id, message: 'Hi' });
      const adminsInvite = await createdInvite(admin, household.id, {
        inviteeEmail: `admin-sent-${randomUUID()}@e2e.invalid`,
        message: 'Hello',
      });

      const revoked = revokeEnvelope(
        await revoke(admin, household.id, ownersInvite.id).expect(200),
        'POST /api/households/:id/invites/:inviteId/revoke',
      );
      const revokedByOwner = revokeEnvelope(
        await revoke(owner, household.id, adminsInvite.id).expect(200),
        'POST /api/households/:id/invites/:inviteId/revoke as owner',
      );

      expect(revoked.invite).toMatchObject({ id: ownersInvite.id, status: InviteStatus.Revoked });
      // A revoking household owner or admin sees who was invited (#167): the
      // address, null on an invite by id. The message stays with the parties.
      expect(revoked.invite).toHaveProperty('inviteeEmail', null);
      expect(revoked.invite).not.toHaveProperty('message');
      expect(revokedByOwner.invite).toMatchObject({ id: adminsInvite.id, inviteeEmail: adminsInvite.inviteeEmail });
      expect(revokedByOwner.invite).not.toHaveProperty('message');
      await expect(storedInvite(ownersInvite.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
      await expect(storedInvite(adminsInvite.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
    });

    it('refuses the inviter with 403, telling them to withdraw, and leaves the invite open', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

      const refused = await revoke(owner, household.id, invite.id).expect(403);

      expect(messageOf(refused)).toEqual(expect.stringContaining('withdraw'));
      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    });

    it("answers 403 to a member and to another household's Owner, and 404 to an invite from another household", async () => {
      const [owner, member, otherOwner, invitee, otherInvitee] = await Promise.all(
        Array.from({ length: 5 }, () => actors.user()),
      );
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      const { household: other } = await actors.householdWithMembers({ owner: otherOwner });
      const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });
      const othersInvite = await createdInvite(otherOwner, other.id, { inviteeId: otherInvitee.user.id });

      await revoke(member, household.id, invite.id).expect(403);
      await revoke(otherOwner, household.id, invite.id).expect(403);
      // Authorized over its own household, handed the other's invite id: the
      // read is bound to the household in the path, so nothing is found.
      await revoke(otherOwner, other.id, invite.id).expect(404);
      await revoke(owner, household.id, othersInvite.id).expect(404);

      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
      await expect(storedInvite(othersInvite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    });

    it('answers 410 for an expired invite, 409 for a settled one, and 404 once the household is deleted', async () => {
      const [owner, admin, lapsed, declined, invitee] = await Promise.all(
        Array.from({ length: 5 }, () => actors.user()),
      );
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const expired = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: household.id,
        inviteeId: lapsed.user.id,
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      const settled = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: household.id,
        inviteeId: declined.user.id,
        status: InviteStatus.Declined,
      });
      const open = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

      await revoke(admin, household.id, expired.id).expect(410);
      await revoke(admin, household.id, settled.id).expect(409);

      await request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers).expect(200);
      await revoke(admin, household.id, open.id).expect(404);
    });
  });

  describe('through an API key', () => {
    it("revokes someone else's invite, but never its owner's own, which only a signed-in owner withdraws", async () => {
      const [owner, admin, first, second] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const key = await inviteKey(admin, ['update:household_invite:revoke:as-admin']);
      const ownersInvite = await createdInvite(owner, household.id, { inviteeId: first.user.id });
      const adminsInvite = await createdInvite(admin, household.id, { inviteeId: second.user.id });

      await revoke(key, household.id, ownersInvite.id).expect(200);
      const refused = await revoke(key, household.id, adminsInvite.id).expect(403);
      await withdraw(key, adminsInvite.id).expect(403);

      // Refused as its owner's own invite, not for want of a grant, and told
      // that withdrawing takes a signed-in owner, which a key never is.
      expect(messageOf(refused)).toEqual(expect.stringMatching(/withdraw.*signed in/));

      await expect(storedInvite(ownersInvite.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
      await expect(storedInvite(adminsInvite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });

      await withdraw(admin, adminsInvite.id).expect(200);
    });

    it('revokes the one invite it is scoped to, and no other', async () => {
      const [owner, admin, first, second] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const scopedTo = await createdInvite(owner, household.id, { inviteeId: first.user.id });
      const other = await createdInvite(owner, household.id, { inviteeId: second.user.id });
      const key = await inviteKey(admin, ['update:household_invite:revoke:as-admin'], scopedTo.id);

      await revoke(key, household.id, other.id).expect(403);
      await revoke(key, household.id, scopedTo.id).expect(200);

      await expect(storedInvite(scopedTo.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
      await expect(storedInvite(other.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    });

    it('cannot decline for its owner', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const key = await inviteKey(invitee, []);
      const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });
      const { token } = await storedInvite(invite.id);

      await declineById(key, invite.id).expect(403);
      await declineByToken(key, token).expect(403);

      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    });
  });
});
