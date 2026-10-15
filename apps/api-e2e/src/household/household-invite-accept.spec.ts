import { HouseholdMembershipOrigin, InviteStatus, InviteType, QuotaScope, SystemRole } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { acceptEnvelope, inviteEnvelope } from './household-invite-wire';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Accepting a household invite (#163): `POST /api/invites/:inviteId/accept`
 * for an invite the caller received, and `POST /api/invites/accept` with the
 * token from its link in the body. Accepting joins the household.
 *
 * Actors and rosters are arranged before any of them sends a request, as in
 * `household-invites.spec.ts`: the API caches each user's ability on first use
 * and this process cannot evict it (#256).
 */
describe('accepting a household invite', () => {
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

  const acceptById = (actor: AuthenticatedActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/accept`).set(actor.headers);

  const acceptByToken = (actor: AuthenticatedActor, token: unknown) =>
    request(baseUrl).post('/api/invites/accept').set(actor.headers).send({ token });

  const createdInvite = async (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(
      await request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body).expect(201),
      'POST /api/households/:id/invites',
    ).invite;

  const listHouseholdInvites = (actor: AuthenticatedActor, householdId: string) =>
    request(baseUrl).get(`/api/households/${householdId}/invites`).set(actor.headers);

  const storedInvite = (id: string) => db.client.invite.findUniqueOrThrow({ where: { id } });

  const membership = (householdId: string, userId: string) =>
    db.client.householdMember.findUnique({ where: { householdId_userId: { householdId, userId } } });

  const verify = (actor: SessionActor) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { emailVerified: true } });

  /** An invite written directly, for a state no route produces. */
  const arrangeInvite = (
    inviter: SessionActor,
    householdId: string,
    data: { inviteeId?: string; inviteeEmail?: string; status?: InviteStatus; expiresAt?: Date; withheld?: boolean },
  ) =>
    db.client.invite.create({
      data: {
        type: InviteType.Household,
        inviterId: inviter.user.id,
        householdId,
        token: randomUUID(),
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + DAY_MS),
        ...data,
      },
    });

  const ownedHousehold = async () => {
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner });

    return { owner, household };
  };

  /** Status plus message, so a surprise reads as a diff rather than as `500`. */
  const outcome = (response: { status: number; body: unknown }) => ({
    status: response.status,
    message: (response.body as { message?: unknown } | null)?.message ?? null,
  });

  describe('joining', () => {
    it('joins by id with the role offered, as the inviter invited, and holds the role at once', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const invite = await createdInvite(owner, household.id, {
        inviteeId: invitee.user.id,
        role: SystemRole.HouseholdAdmin,
      });

      // Asked before joining, so the invitee's ability is cached without the
      // household. An admin's grant on the household's invites is rendered
      // per household into that cache, unlike the membership check a plain
      // read makes in its query, so only an evicted cache answers 200 after.
      await listHouseholdInvites(invitee, household.id).expect(403);

      const accepted = acceptEnvelope(await acceptById(invitee, invite.id).expect(200), 'POST /api/invites/:id/accept');

      expect(accepted.invite).toMatchObject({ id: invite.id, status: InviteStatus.Accepted });
      expect(accepted.invite).not.toHaveProperty('token');
      expect(accepted.member).toMatchObject({
        householdId: household.id,
        userId: invitee.user.id,
        role: { role: { name: SystemRole.HouseholdAdmin } },
      });
      expect(accepted.member).not.toHaveProperty('origin');
      expect(accepted.member).not.toHaveProperty('addedById');

      await expect(membership(household.id, invitee.user.id)).resolves.toMatchObject({
        origin: HouseholdMembershipOrigin.InviteAccepted,
        addedById: owner.user.id,
      });
      await expect(storedInvite(invite.id)).resolves.toMatchObject({
        status: InviteStatus.Accepted,
        inviteeId: invitee.user.id,
        respondedAt: expect.any(Date),
      });

      await listHouseholdInvites(invitee, household.id).expect(200);
    });

    it('joins by the id of an invite to a verified address, and binds the invite to the account', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      await verify(invitee);
      const invite = await createdInvite(owner, household.id, { inviteeEmail: invitee.user.email });

      await acceptById(invitee, invite.id).expect(200);

      await expect(storedInvite(invite.id)).resolves.toMatchObject({
        status: InviteStatus.Accepted,
        inviteeId: invitee.user.id,
      });
      await expect(membership(household.id, invitee.user.id)).resolves.not.toBeNull();
    });

    it('joins by the token in the body, whoever holds it and whatever their address', async () => {
      const [owner, holder] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const invite = await createdInvite(owner, household.id, { inviteeEmail: `link-${randomUUID()}@e2e.invalid` });
      const { token } = await storedInvite(invite.id);

      await acceptByToken(holder, '').expect(400);
      await acceptByToken(holder, undefined).expect(400);

      const accepted = acceptEnvelope(await acceptByToken(holder, token).expect(200), 'POST /api/invites/accept');

      expect(accepted.member).toMatchObject({ householdId: household.id, userId: holder.user.id });
      await expect(storedInvite(invite.id)).resolves.toMatchObject({ inviteeId: holder.user.id });
    });

    it('leaves a twin invite open, and refuses it once its invitee has joined', async () => {
      // One person, invited by id and by their verified address: both are
      // allowed to stand (#162), and accepting either joins them.
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      await verify(invitee);
      const byId = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });
      const byAddress = await createdInvite(owner, household.id, { inviteeEmail: invitee.user.email });

      await acceptById(invitee, byId.id).expect(200);

      await expect(storedInvite(byAddress.id)).resolves.toMatchObject({ status: InviteStatus.Pending });

      const refused = await acceptById(invitee, byAddress.id).expect(409);
      expect(outcome(refused).message).toContain(household.id);
      await expect(storedInvite(byAddress.id)).resolves.toMatchObject({
        status: InviteStatus.Pending,
        inviteeId: null,
      });
    });
  });

  describe('refusing', () => {
    it('answers 404 for an unverified address, a withheld invite and a stranger, and 403 for the inviter', async () => {
      const [owner, unverified, blocked, stranger, invitee] = await Promise.all(
        Array.from({ length: 5 }, () => actors.user()),
      );
      const { household } = await actors.householdWithMembers({ owner });
      await verify(blocked);

      const toUnverified = await createdInvite(owner, household.id, { inviteeEmail: unverified.user.email });
      const withheld = await arrangeInvite(owner, household.id, { inviteeEmail: blocked.user.email, withheld: true });
      const toInvitee = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

      await acceptById(unverified, toUnverified.id).expect(404);
      await acceptById(blocked, withheld.id).expect(404);
      // Its link was never sent, so it answers nobody who follows one (#278).
      await acceptByToken(blocked, withheld.token).expect(404);
      await acceptById(stranger, toInvitee.id).expect(404);
      await acceptByToken(stranger, `not-a-token-${randomUUID()}`).expect(404);
      await acceptById(owner, toInvitee.id).expect(403);

      const invites = await db.client.invite.findMany({ where: { householdId: household.id } });
      expect(invites.map((row) => row.status)).toEqual([
        InviteStatus.Pending,
        InviteStatus.Pending,
        InviteStatus.Pending,
      ]);
      expect(await db.client.householdMember.count({ where: { householdId: household.id } })).toBe(1);
    });

    it('answers 410 for an expired invite and 409 for a declined or revoked one', async () => {
      const [owner, lapsed, declined, revoked] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({ owner });

      const expiredInvite = await arrangeInvite(owner, household.id, {
        inviteeId: lapsed.user.id,
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      const declinedInvite = await arrangeInvite(owner, household.id, {
        inviteeId: declined.user.id,
        status: InviteStatus.Declined,
      });
      const revokedInvite = await arrangeInvite(owner, household.id, {
        inviteeId: revoked.user.id,
        status: InviteStatus.Revoked,
      });

      await acceptById(lapsed, expiredInvite.id).expect(410);
      await acceptById(declined, declinedInvite.id).expect(409);
      await acceptById(revoked, revokedInvite.id).expect(409);

      expect(await db.client.householdMember.count({ where: { householdId: household.id } })).toBe(1);
    });

    it('answers 402 when the household is at its member cap, and leaves the invite open', async () => {
      // 402 is what `QuotaExceededException` answers everywhere; #288 decides
      // whether it should, and this assertion moves with it.
      const { owner, household } = await ownedHousehold();
      const invitee = await actors.user();
      await db.client.quota.create({
        data: {
          scope: QuotaScope.Household,
          scopeId: household.id,
          householdId: household.id,
          resource: 'household_member_count',
          limit: 1n,
        },
      });
      const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

      const refused = await acceptById(invitee, invite.id).expect(402);

      expect(refused.body).toMatchObject({ resource: 'household_member_count', scope: QuotaScope.Household });
      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
      await expect(membership(household.id, invitee.user.id)).resolves.toBeNull();
    });

    it('answers 409 to someone already a member, and leaves the invite open', async () => {
      const [owner, member] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdGuest }],
      });
      await verify(member);
      // An address names no account at create, so a member's is invited like
      // anyone's (#162), here with a role above the one they hold.
      const invite = await createdInvite(owner, household.id, {
        inviteeEmail: member.user.email,
        role: SystemRole.HouseholdAdmin,
      });

      const refused = await acceptById(member, invite.id).expect(409);

      expect(outcome(refused).message).toContain(household.id);
      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Pending, inviteeId: null });
      const role = await db.client.householdRole.findFirstOrThrow({
        where: { householdMember: { householdId: household.id, userId: member.user.id } },
        select: { role: { select: { name: true } } },
      });
      expect(role.role.name).toBe(SystemRole.HouseholdGuest);
    });

    it('refuses an anonymous guest with 403, by id or by token', async () => {
      const { owner, household } = await ownedHousehold();
      const guest = await actors.anonymous();
      const invite = await createdInvite(owner, household.id, { inviteeEmail: `guest-${randomUUID()}@e2e.invalid` });
      const { token } = await storedInvite(invite.id);

      await acceptById(guest, invite.id).expect(403);
      await acceptByToken(guest, token).expect(403);
      await expect(storedInvite(invite.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    });
  });
});
