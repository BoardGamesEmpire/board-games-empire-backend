import { InviteStatus, SystemRole } from '@bge/database';
import { createActors, type Actors, type HouseholdRoleName, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { inviteEnvelope } from './household-invite-wire';
import { createMemberClient } from './household-request';

/**
 * Only a household owner acts on the household admin role (#168): makes
 * someone a household admin, changes a household admin's role, invites with
 * that role, or revokes an invite offering it. A household admin does each of
 * these for the member and guest roles. Removal is driven in
 * `household-member-removal.spec.ts`, beside the rest of removal.
 *
 * Each refusal is checked against the database as well as the status, so a
 * 403 that wrote anyway fails. Actors and rosters are arranged before any of
 * them sends a request, as the API caches each user's ability on first use
 * (#256); every role change after that goes through a route that evicts it.
 */
describe('acting on the household admin role (#168)', () => {
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

  const { changeRole } = createMemberClient(baseUrl);

  const invite = (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body);

  const revoke = (actor: SessionActor, householdId: string, inviteId: string) =>
    request(baseUrl).post(`/api/households/${householdId}/invites/${inviteId}/revoke`).set(actor.headers);

  const roleOf = async (memberId: string) =>
    (
      await db.client.householdRole.findUniqueOrThrow({
        where: { householdMemberId: memberId },
        select: { role: { select: { name: true } } },
      })
    ).role.name;

  /** An owner, a household admin, and one more member holding `role`. */
  const household = async (role: HouseholdRoleName) => {
    const [owner, admin, other] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Who holds the admin role',
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        { actor: other, role },
      ],
    });

    return { householdId: fixture.household.id, owner, admin, otherId: fixture.members[1].member.id };
  };

  describe('changing a household role', () => {
    it("refuses a household admin another household admin's role change, and leaves the role as it was", async () => {
      const { householdId, admin, otherId } = await household(SystemRole.HouseholdAdmin);

      await changeRole(admin, householdId, otherId, SystemRole.HouseholdMember).expect(403);

      await expect(roleOf(otherId)).resolves.toBe(SystemRole.HouseholdAdmin);
    });

    it('refuses a household admin a member made household admin, and leaves the role as it was', async () => {
      const { householdId, admin, otherId } = await household(SystemRole.HouseholdMember);

      await changeRole(admin, householdId, otherId, SystemRole.HouseholdAdmin).expect(403);

      await expect(roleOf(otherId)).resolves.toBe(SystemRole.HouseholdMember);
    });

    it('lets a household admin make a household guest a member', async () => {
      const { householdId, admin, otherId } = await household(SystemRole.HouseholdGuest);

      await changeRole(admin, householdId, otherId, SystemRole.HouseholdMember).expect(200);

      await expect(roleOf(otherId)).resolves.toBe(SystemRole.HouseholdMember);
    });

    it('lets the household owner make a member a household admin, and make them a member again', async () => {
      const { householdId, owner, otherId } = await household(SystemRole.HouseholdMember);

      await changeRole(owner, householdId, otherId, SystemRole.HouseholdAdmin).expect(200);
      await expect(roleOf(otherId)).resolves.toBe(SystemRole.HouseholdAdmin);

      await changeRole(owner, householdId, otherId, SystemRole.HouseholdMember).expect(200);
      await expect(roleOf(otherId)).resolves.toBe(SystemRole.HouseholdMember);
    });
  });

  describe('inviting', () => {
    it('refuses a household admin an invite with the household admin role, and lets the owner send it', async () => {
      const { householdId, owner, admin } = await household(SystemRole.HouseholdMember);
      const invitee = await actors.user();
      const body = { inviteeId: invitee.user.id, role: SystemRole.HouseholdAdmin };

      await invite(admin, householdId, body).expect(403);
      await expect(db.client.invite.count({ where: { householdId } })).resolves.toBe(0);

      const sent = inviteEnvelope(await invite(owner, householdId, body).expect(201), 'POST …/invites as owner');
      expect(sent.invite).toMatchObject({ role: { name: SystemRole.HouseholdAdmin } });
    });

    it('lets a household admin invite with the guest role', async () => {
      const { householdId, admin } = await household(SystemRole.HouseholdMember);
      const invitee = await actors.user();

      await invite(admin, householdId, { inviteeId: invitee.user.id, role: SystemRole.HouseholdGuest }).expect(201);
    });
  });

  describe('revoking', () => {
    it("refuses a household admin the revoke of the owner's invite with the household admin role, and leaves it open", async () => {
      const { householdId, owner, admin } = await household(SystemRole.HouseholdMember);
      const invitee = await actors.user();
      const sent = inviteEnvelope(
        await invite(owner, householdId, { inviteeId: invitee.user.id, role: SystemRole.HouseholdAdmin }).expect(201),
        'POST …/invites as owner',
      ).invite;

      await revoke(admin, householdId, sent.id).expect(403);

      await expect(db.client.invite.findUniqueOrThrow({ where: { id: sent.id } })).resolves.toMatchObject({
        status: InviteStatus.Pending,
      });
    });

    it("answers a household admin 404 for a revoke on another household's invite", async () => {
      // The admin may revoke invites in their own household, so the invite
      // this one doesn't have is a 404, not a 403: the household's invite
      // read finds nothing, and the admin is asked about one offering the
      // member role.
      const { householdId, admin } = await household(SystemRole.HouseholdMember);
      const [otherOwner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household: other } = await actors.householdWithMembers({ owner: otherOwner, name: 'Elsewhere' });
      const elsewhere = inviteEnvelope(
        await invite(otherOwner, other.id, { inviteeId: invitee.user.id, role: SystemRole.HouseholdAdmin }).expect(201),
        'POST …/invites elsewhere',
      ).invite;

      await revoke(admin, householdId, elsewhere.id).expect(404);

      await expect(db.client.invite.findUniqueOrThrow({ where: { id: elsewhere.id } })).resolves.toMatchObject({
        status: InviteStatus.Pending,
      });
    });
  });
});
