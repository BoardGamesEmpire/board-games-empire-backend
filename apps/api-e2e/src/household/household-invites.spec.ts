import { InviteStatus, InviteType, MemberInvitePolicy, SystemRole } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createEventClient, EVENTS_PATH } from '../event/event-request';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { inviteEnvelope, inviteListEnvelope } from './household-invite-wire';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The household invite routes (#162): who may invite whom, and who sees which
 * rows of the list.
 *
 * Actors and rosters are arranged before any of them sends a request. The API
 * caches each user's ability on first use and this process cannot evict it
 * (#256), so a role written after a user's first request would not apply.
 */
describe('household invites', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { createdEventId } = createEventClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const invitesPath = (householdId: string) => `/api/households/${householdId}/invites`;

  const createInvite = (actor: AuthenticatedActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(invitesPath(householdId)).set(actor.headers).send(body);

  const listInvites = (actor: AuthenticatedActor, householdId: string, query: Record<string, string> = {}) =>
    request(baseUrl).get(invitesPath(householdId)).query(query).set(actor.headers);

  const createdInvite = async (actor: AuthenticatedActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(await createInvite(actor, householdId, body).expect(201), 'POST /api/households/:id/invites').invite;

  const storedInvite = (id: string) => db.client.invite.findUniqueOrThrow({ where: { id } });

  const verify = (actor: SessionActor) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { emailVerified: true } });

  /** An invite written directly, for a status no route produces yet. */
  const arrangeInvite = (
    inviter: SessionActor,
    householdId: string,
    data: { status: InviteStatus; expiresAt: Date; inviteeEmail: string },
  ) =>
    db.client.invite.create({
      data: { type: InviteType.Household, inviterId: inviter.user.id, householdId, token: randomUUID(), ...data },
    });

  describe('creating', () => {
    it('lets an owner and an admin invite, and refuses a guest, and a member where members may not', async () => {
      const [owner, admin, member, guest, first, second, third] = await Promise.all(
        Array.from({ length: 7 }, () => actors.user()),
      );
      // How a member's invite opens under the other policies is
      // `household-invite-approval.spec.ts`'s (#166).
      const { household } = await actors.householdWithMembers({
        owner,
        members: [
          { actor: admin, role: SystemRole.HouseholdAdmin },
          { actor: member, role: SystemRole.HouseholdMember },
          { actor: guest, role: SystemRole.HouseholdGuest },
        ],
        memberInvitePolicy: MemberInvitePolicy.Off,
      });

      const byOwner = await createdInvite(owner, household.id, { inviteeId: first.user.id, message: 'Join us' });
      // Offering the guest role: only the owner invites with the household
      // admin role (#168).
      const byAdmin = await createdInvite(admin, household.id, {
        inviteeId: second.user.id,
        role: SystemRole.HouseholdGuest,
      });

      const profile = await db.client.userProfile.findUnique({ where: { userId: first.user.id } });
      expect(byOwner).toMatchObject({
        status: InviteStatus.Pending,
        type: InviteType.Household,
        inviteeName: profile?.displayName || first.user.username,
        inviteeEmail: null,
        message: 'Join us',
        role: { name: SystemRole.HouseholdMember },
        inviter: { id: owner.user.id },
      });
      expect(byOwner).not.toHaveProperty('token');
      expect(byAdmin.role).toMatchObject({ name: SystemRole.HouseholdGuest });

      const stored = await storedInvite(byOwner.id);
      expect(stored).toMatchObject({ inviteeId: first.user.id, inviteeEmail: null, householdId: household.id });
      // An invite by id never copies the account's address: the party shape
      // would hand it to the inviter.
      expect(stored.token.length).toBeGreaterThan(0);
      expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeCloseTo(7 * DAY_MS, -4);

      await createInvite(member, household.id, { inviteeId: third.user.id }).expect(403);
      await createInvite(guest, household.id, { inviteeId: third.user.id }).expect(403);
      expect(await db.client.invite.count({ where: { householdId: household.id } })).toBe(2);
    });

    it('refuses an event participant who holds no role in the household', async () => {
      // A participant holds `create:event_invite`, so the route's type-only
      // check passes them (pinned in `ability.factory.spec.ts`); the 403 here
      // is the service's question about an invite into this household.
      const [owner, host, participant, invitee] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({ owner });
      const eventId = await createdEventId(host);
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/attendees`)
        .set(host.headers)
        .send({ userId: participant.user.id, role: SystemRole.EventParticipant })
        .expect(201);

      await createInvite(participant, household.id, { inviteeId: invitee.user.id }).expect(403);
      expect(await db.client.invite.count({ where: { householdId: household.id } })).toBe(0);
    });

    it('refuses the owner of another household, who passes the type-only check', async () => {
      const [owner, elsewhereOwner, invitee] = await Promise.all(Array.from({ length: 3 }, () => actors.user()));
      // A guest here, who may not invite here (#166).
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: elsewhereOwner, role: SystemRole.HouseholdGuest }],
      });
      await actors.householdWithMembers({ owner: elsewhereOwner });

      await createInvite(elsewhereOwner, household.id, { inviteeId: invitee.user.id }).expect(403);
      await listInvites(elsewhereOwner, household.id).expect(403);
    });

    it('requires exactly one way of naming the invitee', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });

      await createInvite(owner, household.id, {}).expect(400);
      // `@IsOptional` passes a JSON null; it names nobody, so it is no invitee.
      await createInvite(owner, household.id, { inviteeEmail: null }).expect(400);
      await createInvite(owner, household.id, { inviteeId: invitee.user.id, inviteeName: '   ' }).expect(400);
      await createInvite(owner, household.id, { inviteeId: invitee.user.id, inviteeEmail: invitee.user.email }).expect(
        400,
      );
      await createInvite(owner, household.id, { inviteeId: invitee.user.id, role: SystemRole.HouseholdOwner }).expect(
        400,
      );
      await createInvite(owner, household.id, {
        inviteeId: invitee.user.id,
        expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
      }).expect(400);
    });

    it('opens an email-only invite for any address, and answers the same whoever holds it', async () => {
      const [owner, verified, unverified] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      await verify(verified);
      const nobody = `nobody-${randomUUID()}@e2e.invalid`;

      const toVerified = await createdInvite(owner, household.id, {
        inviteeEmail: verified.user.email.toUpperCase(),
        inviteeName: 'Vee',
      });
      const toUnverified = await createdInvite(owner, household.id, {
        inviteeEmail: unverified.user.email,
        inviteeName: 'You',
      });
      const toNobody = await createdInvite(owner, household.id, { inviteeEmail: nobody });

      // Nothing in the response tells the inviter which addresses have
      // accounts: the same keys, the address as typed (lower-cased), the name
      // as typed and never the account's.
      expect(Object.keys(toVerified).sort()).toEqual(Object.keys(toUnverified).sort());
      expect(Object.keys(toNobody).sort()).toEqual(Object.keys(toUnverified).sort());
      expect(toVerified).toMatchObject({ inviteeEmail: verified.user.email, inviteeName: 'Vee' });
      expect(toUnverified).toMatchObject({ inviteeEmail: unverified.user.email, inviteeName: 'You' });
      expect(toNobody).toMatchObject({ inviteeEmail: nobody, inviteeName: null });

      await expect(storedInvite(toVerified.id)).resolves.toMatchObject({
        inviteeId: null,
        inviteeEmail: verified.user.email,
      });
      await expect(storedInvite(toUnverified.id)).resolves.toMatchObject({
        inviteeId: null,
        inviteeEmail: unverified.user.email,
      });
      await expect(storedInvite(toNobody.id)).resolves.toMatchObject({ inviteeId: null, inviteeEmail: nobody });
    });

    it('refuses a second outstanding invite to the same id, or to the same address', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      const address = `someone-${randomUUID()}@e2e.invalid`;

      await createdInvite(owner, household.id, { inviteeId: invitee.user.id });
      await createdInvite(owner, household.id, { inviteeEmail: address });

      await createInvite(owner, household.id, { inviteeId: invitee.user.id }).expect(409);
      await createInvite(owner, household.id, { inviteeEmail: address.toUpperCase() }).expect(409);
      expect(await db.client.invite.count({ where: { householdId: household.id } })).toBe(2);
    });

    it('ties no address to its account by a refusal, in either order or for a member', async () => {
      const [owner, idFirst, addressFirst, member] = await Promise.all(Array.from({ length: 4 }, () => actors.user()));
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      await Promise.all([verify(idFirst), verify(addressFirst), verify(member)]);

      // A user invited by id, then by their verified address; another the
      // other way round; and a member's verified address. A refusal of any of
      // these would tell the inviter whose address it is.
      await createdInvite(owner, household.id, { inviteeId: idFirst.user.id });
      await createdInvite(owner, household.id, { inviteeEmail: idFirst.user.email });
      await createdInvite(owner, household.id, { inviteeEmail: addressFirst.user.email });
      await createdInvite(owner, household.id, { inviteeId: addressFirst.user.id });
      await createdInvite(owner, household.id, { inviteeEmail: member.user.email });

      const byAddress = await db.client.invite.findMany({
        where: { householdId: household.id, inviteeEmail: { not: null } },
        select: { inviteeId: true },
      });
      expect(byAddress).toEqual([{ inviteeId: null }, { inviteeId: null }, { inviteeId: null }]);
    });

    it('refuses a current member by id, and the inviter by id or by their own address', async () => {
      const [owner, member] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      await createInvite(owner, household.id, { inviteeId: member.user.id }).expect(409);
      await createInvite(owner, household.id, { inviteeId: owner.user.id }).expect(400);
      // The inviter's own address is theirs, so refusing it tells them nothing.
      await createInvite(owner, household.id, { inviteeEmail: owner.user.email.toUpperCase() }).expect(400);
      expect(await db.client.invite.count({ where: { householdId: household.id } })).toBe(0);
    });

    it.each([
      // Shaped like the server's own service account: verified, banned, and
      // never able to sign in.
      ['a service account', { isServiceAccount: true, banned: true }],
      // better-auth deletes a guest's account when the guest signs in for real,
      // which would leave an invite by its id naming nobody.
      ['an anonymous guest', { isAnonymous: true }],
    ])('never makes %s an invitee by id', async (_label, shape) => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner });
      const tag = randomUUID();
      const account = await db.client.user.create({
        data: { username: `nonperson-${tag}`, email: `nonperson-${tag}@e2e.invalid`, emailVerified: true, ...shape },
      });

      await createInvite(owner, household.id, { inviteeId: account.id }).expect(404);
      expect(await db.client.invite.count({ where: { householdId: household.id } })).toBe(0);
    });

    it('answers 404 for a deleted household, and for an id no user has', async () => {
      const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });

      await createInvite(owner, household.id, { inviteeId: `missing-${randomUUID()}` }).expect(404);

      await request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers).expect(200);

      await createInvite(owner, household.id, { inviteeId: invitee.user.id }).expect(404);
      await listInvites(owner, household.id).expect(404);
    });
  });

  describe('listing', () => {
    it("shows the household's owners and admins every address, and each the message only on the rows they sent, and refuses a member (#167)", async () => {
      const [owner, admin, member] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [
          { actor: admin, role: SystemRole.HouseholdAdmin },
          { actor: member, role: SystemRole.HouseholdMember },
        ],
      });

      const ownersInvite = await createdInvite(owner, household.id, {
        inviteeEmail: `owner-sent-${randomUUID()}@e2e.invalid`,
        message: 'From the owner',
      });
      const adminsInvite = await createdInvite(admin, household.id, {
        inviteeEmail: `admin-sent-${randomUUID()}@e2e.invalid`,
        message: 'From the admin',
      });

      const asOwner = inviteListEnvelope(
        await listInvites(owner, household.id).expect(200),
        'GET /api/households/:id/invites as owner',
      );
      // Newest first.
      expect(asOwner.invites.map((invite) => invite.id)).toEqual([adminsInvite.id, ownersInvite.id]);
      expect(asOwner.pagination).toMatchObject({ page: 1, total: 2, hasMore: false });
      expect(asOwner.invites[1]).toMatchObject({
        inviteeEmail: ownersInvite.inviteeEmail,
        message: 'From the owner',
      });
      // A household owner sees who another member invited (#167), and not what
      // that member wrote to them.
      expect(asOwner.invites[0]).toMatchObject({ inviteeEmail: adminsInvite.inviteeEmail });
      expect(asOwner.invites[0]).not.toHaveProperty('message');
      expect(asOwner.invites[0]).toMatchObject({ inviter: { id: admin.user.id }, status: InviteStatus.Pending });

      const asAdmin = inviteListEnvelope(
        await listInvites(admin, household.id).expect(200),
        'GET /api/households/:id/invites as admin',
      );
      expect(asAdmin.invites[0]).toMatchObject({ inviteeEmail: adminsInvite.inviteeEmail, message: 'From the admin' });
      expect(asAdmin.invites[1]).toMatchObject({ inviteeEmail: ownersInvite.inviteeEmail });
      expect(asAdmin.invites[1]).not.toHaveProperty('message');

      await listInvites(member, household.id).expect(403);
    });

    it('lists the open invites by default, and any status as it stands now on request', async () => {
      const [owner, outsider] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({ owner });
      // Another household's invite, which no filter may reach.
      const { household: other } = await actors.householdWithMembers({ owner: outsider });

      const open = await createdInvite(owner, household.id, { inviteeEmail: `open-${randomUUID()}@e2e.invalid` });
      // Still `Pending` on the row, but past its window: it is `Expired` now.
      const lapsed = await arrangeInvite(owner, household.id, {
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() - DAY_MS),
        inviteeEmail: `lapsed-${randomUUID()}@e2e.invalid`,
      });
      const declined = await arrangeInvite(owner, household.id, {
        status: InviteStatus.Declined,
        expiresAt: new Date(Date.now() + DAY_MS),
        inviteeEmail: `declined-${randomUUID()}@e2e.invalid`,
      });
      await arrangeInvite(outsider, other.id, {
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + DAY_MS),
        inviteeEmail: `elsewhere-${randomUUID()}@e2e.invalid`,
      });

      const listed = async (query: Record<string, string> = {}) =>
        inviteListEnvelope(
          await listInvites(owner, household.id, query).expect(200),
          `GET /api/households/:id/invites ${JSON.stringify(query)}`,
        ).invites;

      expect((await listed()).map((invite) => invite.id)).toEqual([open.id]);

      const expired = await listed({ status: InviteStatus.Expired });
      expect(expired.map((invite) => invite.id)).toEqual([lapsed.id]);
      expect(expired[0]?.status).toBe(InviteStatus.Expired);

      expect((await listed({ status: InviteStatus.Pending })).map((invite) => invite.id)).toEqual([open.id]);
      expect((await listed({ status: InviteStatus.Declined })).map((invite) => invite.id)).toEqual([declined.id]);

      await listInvites(owner, household.id, { status: 'Lost' }).expect(400);
    });

    /**
     * Also the end-to-end half of #297, which the household detail carried
     * until it stopped embedding invites (#665). `read-shapes.spec.ts` pins the
     * select constant and the service specs pin that the query uses it;
     * neither reads a response. This reads one over HTTP, in the context shape
     * staff get, so a shape correct in source and wrong by the time it reaches
     * a client still fails.
     */
    it("lets staff read a household's invites, in the shape a context reader gets", async () => {
      const [owner, staff] = await Promise.all([actors.user(), actors.admin()]);
      const { household } = await actors.householdWithMembers({ owner });
      const invite = await createdInvite(owner, household.id, { inviteeEmail: `staff-${randomUUID()}@e2e.invalid` });

      const asStaff = inviteListEnvelope(
        await listInvites(staff, household.id).expect(200),
        'GET /api/households/:id/invites as staff',
      );

      // Asserted BEFORE the absences below, which a row the read never
      // returned would satisfy just as well.
      expect(asStaff.invites.map((row) => row.id)).toEqual([invite.id]);

      // Named one at a time rather than left to the key set, so a regression
      // says WHICH credential came back instead of printing two sorted lists.
      expect(asStaff.invites[0]).not.toHaveProperty('token');
      expect(asStaff.invites[0]).not.toHaveProperty('inviteeEmail');

      // And the whole key set, because naming the two known leaks only catches
      // the two known leaks: the defect class is a column nobody chose to
      // publish, which by definition is on no list written today.
      expect(Object.keys(asStaff.invites[0]).sort()).toEqual(
        ['createdAt', 'expiresAt', 'id', 'inviteeName', 'inviter', 'role', 'status', 'type'].sort(),
      );
    });
  });
});
