import { InviteStatus, MemberInvitePolicy, ResourceType, SystemRole } from '@bge/database';
import { arrangeInvite, createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  acceptEnvelope,
  approveEnvelope,
  inviteEnvelope,
  inviteListEnvelope,
  receivedInvitesEnvelope,
  sentInvitesEnvelope,
} from './household-invite-wire';
import { createEnvelope, listEnvelope, readEnvelope } from './household-wire';

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Members inviting under their household's own policy, an owner or admin
 * approving what waits (#166), and the list of invites a user has sent (#751).
 *
 * - `PATCH /api/households/:id` with `settings.memberInvitePolicy` sets the
 *   policy, and `GET /api/households/:id` shows it to every reader.
 * - `POST /api/households/:householdId/invites` by a member opens the invite
 *   directly, awaiting approval, or not at all, as the policy says.
 * - `POST /api/households/:householdId/invites/:inviteId/approve` opens one
 *   awaiting approval to its invitee.
 * - `GET /api/invites/sent` lists the invites the acting user sent.
 *
 * Actors and rosters are arranged before any of them sends a request, as in
 * `household-invites.spec.ts`: the API caches each user's ability on first use
 * and this process cannot evict it (#256).
 */
describe('member invites, their approval, and the invites a user has sent', () => {
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

  const invite = (actor: Caller, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body);

  const createdInvite = async (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(await invite(actor, householdId, body).expect(201), 'POST /api/households/:id/invites').invite;

  const approve = (actor: Caller, householdId: string, inviteId: string) =>
    request(baseUrl).post(`/api/households/${householdId}/invites/${inviteId}/approve`).set(actor.headers);

  const revoke = (actor: Caller, householdId: string, inviteId: string) =>
    request(baseUrl).post(`/api/households/${householdId}/invites/${inviteId}/revoke`).set(actor.headers);

  const accept = (actor: Caller, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/accept`).set(actor.headers);

  const withdraw = (actor: Caller, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/withdraw`).set(actor.headers);

  const patchSettings = (actor: Caller, householdId: string, settings: Record<string, unknown>) =>
    request(baseUrl).patch(`/api/households/${householdId}`).set(actor.headers).send({ settings });

  const inbox = async (actor: SessionActor) =>
    receivedInvitesEnvelope(
      await request(baseUrl).get('/api/invites').set(actor.headers).expect(200),
      'GET /api/invites',
    ).invites;

  const sent = async (actor: SessionActor, status?: InviteStatus) =>
    sentInvitesEnvelope(
      await request(baseUrl)
        .get('/api/invites/sent')
        .query(status === undefined ? {} : { status })
        .set(actor.headers)
        .expect(200),
      'GET /api/invites/sent',
    ).invites;

  const householdInvites = async (actor: SessionActor, householdId: string, status?: InviteStatus) =>
    inviteListEnvelope(
      await request(baseUrl)
        .get(`/api/households/${householdId}/invites`)
        .query(status === undefined ? {} : { status })
        .set(actor.headers)
        .expect(200),
      'GET /api/households/:id/invites',
    ).invites;

  const storedInvite = (id: string) => db.client.invite.findUniqueOrThrow({ where: { id } });

  /** The message a refusal carries, so a surprise reads as a diff rather than as a bare status. */
  const messageOf = (response: { body: unknown }) => (response.body as { message?: unknown } | null)?.message;

  /** A household with an owner, an admin, a member and a guest, under `policy`. */
  const household = async (memberInvitePolicy?: MemberInvitePolicy) => {
    const [owner, admin, member, guest, invitee, other] = await Promise.all(
      Array.from({ length: 6 }, () => actors.user()),
    );
    const { household: created } = await actors.householdWithMembers({
      owner,
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        { actor: member, role: SystemRole.HouseholdMember },
        { actor: guest, role: SystemRole.HouseholdGuest },
      ],
      memberInvitePolicy,
    });

    return { householdId: created.id, owner, admin, member, guest, invitee, other };
  };

  describe("the household's member invite policy (#166)", () => {
    it('defaults to NeedsApproval, shows to every reader, and is set by an owner or admin and no one else', async () => {
      const { householdId, owner, admin, member, guest } = await household();

      const read = async (actor: SessionActor) =>
        readEnvelope(
          await request(baseUrl).get(`/api/households/${householdId}`).set(actor.headers).expect(200),
          'GET /api/households/:id',
        ).household.settings;

      // A member's client needs it to know whether to offer an invite.
      await expect(read(member)).resolves.toEqual({ memberInvitePolicy: MemberInvitePolicy.NeedsApproval });
      await expect(read(guest)).resolves.toEqual({ memberInvitePolicy: MemberInvitePolicy.NeedsApproval });

      // The list carries it as well, so a client need not read each household.
      const listed = listEnvelope(
        await request(baseUrl).get('/api/households').set(member.headers).expect(200),
        'GET /api/households',
      ).households.find((row) => row.id === householdId);
      expect((listed as unknown as { settings: unknown } | undefined)?.settings).toEqual({
        memberInvitePolicy: MemberInvitePolicy.NeedsApproval,
      });

      const patched = createEnvelope(
        await patchSettings(owner, householdId, { memberInvitePolicy: MemberInvitePolicy.Direct }).expect(200),
        'PATCH /api/households/:id',
      );
      // The answer carries what it wrote.
      expect((patched.household as unknown as { settings: unknown }).settings).toEqual({
        memberInvitePolicy: MemberInvitePolicy.Direct,
      });
      await patchSettings(admin, householdId, { memberInvitePolicy: MemberInvitePolicy.Off }).expect(200);
      await expect(read(member)).resolves.toEqual({ memberInvitePolicy: MemberInvitePolicy.Off });

      await patchSettings(member, householdId, { memberInvitePolicy: MemberInvitePolicy.Direct }).expect(403);
      await patchSettings(guest, householdId, { memberInvitePolicy: MemberInvitePolicy.Direct }).expect(403);
      await patchSettings(owner, householdId, { memberInvitePolicy: 'Sometimes' }).expect(400);
      await patchSettings(owner, householdId, {}).expect(400);

      await expect(read(owner)).resolves.toEqual({ memberInvitePolicy: MemberInvitePolicy.Off });
    });
  });

  describe("a member's invite (#166)", () => {
    it('opens awaiting approval under NeedsApproval, unseen by the invitee, who cannot accept it yet', async () => {
      const { householdId, member, invitee } = await household(MemberInvitePolicy.NeedsApproval);

      const created = await createdInvite(member, householdId, { inviteeId: invitee.user.id });

      expect(created.status).toBe(InviteStatus.AwaitingApproval);
      await expect(storedInvite(created.id)).resolves.toMatchObject({
        status: InviteStatus.AwaitingApproval,
        needsApproval: true,
        inviterId: member.user.id,
      });
      await expect(inbox(invitee)).resolves.toEqual([]);
      await accept(invitee, created.id).expect(409);
    });

    it('opens directly under Direct, and the invitee sees it and accepts it', async () => {
      const { householdId, member, invitee } = await household(MemberInvitePolicy.Direct);

      const created = await createdInvite(member, householdId, { inviteeId: invitee.user.id });

      expect(created.status).toBe(InviteStatus.Pending);
      await expect(storedInvite(created.id)).resolves.toMatchObject({ needsApproval: false });
      expect((await inbox(invitee)).map((row) => row.id)).toEqual([created.id]);
      await accept(invitee, created.id).expect(200);
    });

    it('is refused under Off, and nothing is stored', async () => {
      const { householdId, member, invitee } = await household(MemberInvitePolicy.Off);

      await invite(member, householdId, { inviteeId: invitee.user.id }).expect(403);

      expect(await db.client.invite.count({ where: { householdId } })).toBe(0);
    });

    it('may offer the guest role, and never the admin role, under any policy that lets members invite', async () => {
      const { householdId, member, invitee, other } = await household(MemberInvitePolicy.Direct);

      await invite(member, householdId, { inviteeId: invitee.user.id, role: SystemRole.HouseholdAdmin }).expect(403);
      const asGuest = await createdInvite(member, householdId, {
        inviteeId: other.user.id,
        role: SystemRole.HouseholdGuest,
      });

      expect(asGuest.role?.name).toBe(SystemRole.HouseholdGuest);
      expect(await db.client.invite.count({ where: { householdId } })).toBe(1);
    });

    it('lets an owner and an admin invite directly under every policy, and a guest under none', async () => {
      const { householdId, owner, admin, guest } = await household();

      for (const memberInvitePolicy of Object.values(MemberInvitePolicy)) {
        // The policy is read at each invite, not cached with the ability.
        await db.client.householdSettings.update({ where: { householdId }, data: { memberInvitePolicy } });
        const [first, second, third] = await Promise.all([actors.user(), actors.user(), actors.user()]);

        // Only the owner invites with the household admin role (#168).
        const byOwner = await createdInvite(owner, householdId, {
          inviteeId: first.user.id,
          role: SystemRole.HouseholdAdmin,
        });
        const byAdmin = await createdInvite(admin, householdId, {
          inviteeId: second.user.id,
          role: SystemRole.HouseholdGuest,
        });
        await invite(guest, householdId, { inviteeId: third.user.id }).expect(403);

        expect({ memberInvitePolicy, statuses: [byOwner.status, byAdmin.status] }).toEqual({
          memberInvitePolicy,
          statuses: [InviteStatus.Pending, InviteStatus.Pending],
        });
      }
    });
  });

  describe('approving (#166)', () => {
    it('lets an admin approve, after which the invitee sees the invite and is admitted with the role offered', async () => {
      const { householdId, admin, member, invitee } = await household();
      const created = await createdInvite(member, householdId, {
        inviteeId: invitee.user.id,
        role: SystemRole.HouseholdGuest,
      });

      // Approvers find what waits on the household's list.
      const waiting = await householdInvites(admin, householdId, InviteStatus.AwaitingApproval);
      expect(waiting.map((row) => row.id)).toEqual([created.id]);

      const approved = approveEnvelope(
        await approve(admin, householdId, created.id).expect(200),
        'POST /api/households/:id/invites/:inviteId/approve',
      );

      expect(approved.invite).toMatchObject({ id: created.id, status: InviteStatus.Pending });
      // An approving household admin sees who is invited (#167): the address,
      // null on this invite by id. The message stays with the parties.
      expect(approved.invite).toHaveProperty('inviteeEmail', null);
      expect(approved.invite).not.toHaveProperty('message');
      await expect(storedInvite(created.id)).resolves.toMatchObject({
        status: InviteStatus.Pending,
        approvedById: admin.user.id,
        approvedAt: expect.any(Date),
      });
      expect((await inbox(invitee)).map((row) => row.id)).toEqual([created.id]);

      const joined = acceptEnvelope(await accept(invitee, created.id).expect(200), 'POST /api/invites/:id/accept');
      expect(joined.member.role?.role.name).toBe(SystemRole.HouseholdGuest);
    });

    it('gives the invitee a full week from the approval, however long the invite waited for it', async () => {
      const { householdId, admin, member, invitee } = await household();
      // Sent six days ago, with a day of its window left.
      const waiting = await arrangeInvite(db.client, {
        inviter: member,
        householdId: householdId,
        inviteeId: invitee.user.id,
        status: InviteStatus.AwaitingApproval,
        expiresAt: new Date(Date.now() + DAY_MS),
      });
      const approvedAt = Date.now();

      await approve(admin, householdId, waiting.id).expect(200);

      const { expiresAt } = await storedInvite(waiting.id);
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(approvedAt + 7 * DAY_MS);
    });

    it('answers 403 to a member and a guest, 404 for an invite from another household, 409 unless it waits, 410 once expired', async () => {
      const { householdId, owner, member, guest, invitee, other } = await household();
      const [otherOwner, lapsedInvitee] = await Promise.all([actors.user(), actors.user()]);
      const { household: elsewhere } = await actors.householdWithMembers({ owner: otherOwner });
      const waiting = await createdInvite(member, householdId, { inviteeId: invitee.user.id });
      const open = await createdInvite(owner, householdId, { inviteeId: other.user.id });
      const lapsed = await arrangeInvite(db.client, {
        inviter: member,
        householdId: householdId,
        inviteeId: lapsedInvitee.user.id,
        status: InviteStatus.AwaitingApproval,
        expiresAt: new Date(Date.now() - DAY_MS),
      });

      await approve(member, householdId, waiting.id).expect(403);
      await approve(guest, householdId, waiting.id).expect(403);
      await approve(otherOwner, householdId, waiting.id).expect(403);
      // Authorized over its own household, handed this one's invite id.
      await approve(otherOwner, elsewhere.id, waiting.id).expect(404);
      await approve(owner, householdId, open.id).expect(409);
      await approve(owner, householdId, lapsed.id).expect(410);

      await expect(storedInvite(waiting.id)).resolves.toMatchObject({ status: InviteStatus.AwaitingApproval });
    });

    it('lets an owner turn a waiting invite down by revoking it', async () => {
      const { householdId, owner, member, invitee } = await household();
      const waiting = await createdInvite(member, householdId, { inviteeId: invitee.user.id });

      await revoke(owner, householdId, waiting.id).expect(200);

      await expect(storedInvite(waiting.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
      await approve(owner, householdId, waiting.id).expect(409);
    });

    it('leaves a waiting invite waiting when the policy changes after it was sent, approvable while its sender could still send it (#747)', async () => {
      const { householdId, owner, member, invitee, other } = await household();
      const waiting = await createdInvite(member, householdId, { inviteeId: invitee.user.id });

      await patchSettings(owner, householdId, { memberInvitePolicy: MemberInvitePolicy.Direct }).expect(200);
      await expect(storedInvite(waiting.id)).resolves.toMatchObject({ status: InviteStatus.AwaitingApproval });
      const direct = await createdInvite(member, householdId, { inviteeId: other.user.id });
      expect(direct.status).toBe(InviteStatus.Pending);

      await patchSettings(owner, householdId, { memberInvitePolicy: MemberInvitePolicy.Off }).expect(200);
      await expect(storedInvite(direct.id)).resolves.toMatchObject({ status: InviteStatus.Pending });

      // Under Off the member could send it neither way, so an approval would
      // hand out an invite the accept revokes. It is refused, and the invite
      // waits on, unapproved.
      const refused = await approve(owner, householdId, waiting.id).expect(409);
      expect((refused.body as { message?: unknown }).message).toContain('can no longer send it');
      await expect(storedInvite(waiting.id)).resolves.toMatchObject({
        status: InviteStatus.AwaitingApproval,
        approvedAt: null,
      });

      await patchSettings(owner, householdId, { memberInvitePolicy: MemberInvitePolicy.Direct }).expect(200);
      await approve(owner, householdId, waiting.id).expect(200);
    });

    describe('kept apart from revoking', () => {
      /**
       * Takes `slug` from the household admin role while `work` runs, leaving
       * it only the other grant, as a server admin editing the role (#772) or
       * a household restricting it (#845) could, and puts the rows back
       * exactly. The admin's ability is built on their first
       * request, so it must come after this starts. The e2e suite runs on one
       * worker, so no other spec sees the gap.
       */
      const withoutAdminGrant = async (slug: string, work: () => Promise<void>) => {
        const where = { role: { name: SystemRole.HouseholdAdmin }, permission: { slug } };
        const rows = await db.client.rolePermission.findMany({ where });
        expect(rows).toHaveLength(1);

        await db.client.rolePermission.deleteMany({ where });
        try {
          await work();
        } finally {
          await db.client.rolePermission.createMany({ data: rows });
        }
      };

      it('refuses revoke to an admin who may only approve', async () => {
        const { householdId, admin, member, invitee, other } = await household();
        const waiting = await createdInvite(member, householdId, { inviteeId: invitee.user.id });
        const another = await createdInvite(member, householdId, { inviteeId: other.user.id });

        await withoutAdminGrant('update:household_invite:revoke:as-admin', async () => {
          await revoke(admin, householdId, waiting.id).expect(403);
          await approve(admin, householdId, another.id).expect(200);
        });

        await expect(storedInvite(waiting.id)).resolves.toMatchObject({ status: InviteStatus.AwaitingApproval });
      });

      it('refuses approve to an admin who may only revoke', async () => {
        const { householdId, admin, member, invitee, other } = await household();
        const waiting = await createdInvite(member, householdId, { inviteeId: invitee.user.id });
        const another = await createdInvite(member, householdId, { inviteeId: other.user.id });

        await withoutAdminGrant('update:household_invite:approve', async () => {
          await approve(admin, householdId, waiting.id).expect(403);
          await revoke(admin, householdId, another.id).expect(200);
        });

        await expect(storedInvite(waiting.id)).resolves.toMatchObject({ status: InviteStatus.AwaitingApproval });
      });
    });
  });

  describe('the invites a user has sent (#751)', () => {
    it('lets a member find an invite they sent and withdraw it', async () => {
      const { householdId, member, invitee } = await household();
      const created = await createdInvite(member, householdId, { inviteeId: invitee.user.id, message: 'Come play' });

      const [row] = await sent(member);
      expect(row).toMatchObject({
        id: created.id,
        status: InviteStatus.AwaitingApproval,
        message: 'Come play',
        household: { id: householdId },
      });
      expect(row).not.toHaveProperty('token');

      await withdraw(member, created.id).expect(200);

      await expect(sent(member)).resolves.toEqual([]);
      await expect(sent(member, InviteStatus.Withdrawn)).resolves.toEqual([
        expect.objectContaining({ id: created.id }),
      ]);
    });

    it("shows nobody another user's sent invites", async () => {
      const { householdId, owner, admin, member, invitee } = await household(MemberInvitePolicy.Direct);
      await createdInvite(member, householdId, { inviteeId: invitee.user.id });

      // The invitee received it; the owner and admin read the household's
      // list; none of them sent it.
      await expect(sent(owner)).resolves.toEqual([]);
      await expect(sent(admin)).resolves.toEqual([]);
      await expect(sent(invitee)).resolves.toEqual([]);
      expect(await sent(member)).toHaveLength(1);
    });

    it('lists an expired invite before and after the sweep marks it, and not a settled one by default', async () => {
      const { householdId, member } = await household();
      const [lapsedInvitee, declinedInvitee] = await Promise.all([actors.user(), actors.user()]);
      const lapsed = await arrangeInvite(db.client, {
        inviter: member,
        householdId: householdId,
        inviteeId: lapsedInvitee.user.id,
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      await arrangeInvite(db.client, {
        inviter: member,
        householdId: householdId,
        inviteeId: declinedInvitee.user.id,
        status: InviteStatus.Declined,
      });

      await expect(sent(member)).resolves.toEqual([
        expect.objectContaining({ id: lapsed.id, status: InviteStatus.Expired }),
      ]);

      // What the sweep (#165) writes.
      await db.client.invite.update({ where: { id: lapsed.id }, data: { status: InviteStatus.Expired } });

      await expect(sent(member)).resolves.toEqual([
        expect.objectContaining({ id: lapsed.id, status: InviteStatus.Expired }),
      ]);
      expect(await sent(member, InviteStatus.Declined)).toHaveLength(1);
    });

    it('shows a former member nothing from a household they left, whose leaving revoked what was open (#747)', async () => {
      const { householdId, member } = await household(MemberInvitePolicy.Direct);
      const [openInvitee, lapsedInvitee, joiner] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      const open = await createdInvite(member, householdId, { inviteeId: openInvitee.user.id });
      await arrangeInvite(db.client, {
        inviter: member,
        householdId,
        inviteeId: lapsedInvitee.user.id,
        expiresAt: new Date(Date.now() - DAY_MS),
      });
      await arrangeInvite(db.client, {
        inviter: member,
        householdId,
        inviteeId: joiner.user.id,
        status: InviteStatus.Accepted,
      });

      // A control: while a member, they see all three as their filters ask.
      expect(await sent(member)).toHaveLength(2);
      expect(await sent(member, InviteStatus.Accepted)).toHaveLength(1);

      await request(baseUrl).delete(`/api/households/${householdId}/members/me`).set(member.headers).expect(200);

      await expect(storedInvite(open.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
      await expect(sent(member)).resolves.toEqual([]);
      await expect(sent(member, InviteStatus.Revoked)).resolves.toEqual([]);
      await expect(sent(member, InviteStatus.Accepted)).resolves.toEqual([]);
      await expect(sent(member, InviteStatus.Expired)).resolves.toEqual([]);

      // Nothing is left to take back.
      await withdraw(member, open.id).expect(409);
    });

    it('lists nothing into a deleted household', async () => {
      const { householdId, owner, member, invitee } = await household(MemberInvitePolicy.Direct);
      await createdInvite(member, householdId, { inviteeId: invitee.user.id });
      expect(await sent(member)).toHaveLength(1);

      await request(baseUrl).delete(`/api/households/${householdId}`).set(owner.headers).expect(200);

      await expect(sent(member)).resolves.toEqual([]);
      await expect(sent(member, InviteStatus.Revoked)).resolves.toEqual([]);
    });

    it('refuses an API key, which cannot withdraw what it would list', async () => {
      const member = await actors.user();
      const key = await mintApiKey(baseUrl, db.client, member, { slugs: [], resourceType: ResourceType.Invite });

      const refused = await request(baseUrl).get('/api/invites/sent').set(key.headers).expect(403);

      expect(messageOf(refused)).toEqual(expect.any(String));
    });
  });
});
