import { InviteStatus, MemberInvitePolicy, ResourceType, SystemRole } from '@bge/database';
import { arrangeInvite, createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, withBarrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  acceptEnvelope,
  banEnvelope,
  bansPage,
  inviteEnvelope,
  receivedInvitesEnvelope,
} from './household-invite-wire';

const BANNED_INVITEE = 'This user is banned from the household. Lift the ban to invite them.';
const REFUSED = 'You cannot invite this user to a household';
const BANNED_FROM_HOUSEHOLD = "You can't become a member of this household because you are banned from it.";
const BAN_FORBIDDEN = 'Only a household owner can ban a household admin or another owner';

/**
 * The household row as a role transition holds it. An accept's share lock
 * waits on it, and so does a ban, which takes the same lock.
 */
const HOLD_HOUSEHOLD = 'SELECT h.id FROM households h WHERE h.id = $1 FOR NO KEY UPDATE';

/**
 * Banning a user from a household, changing a ban's reason and lifting it
 * (#782).
 *
 * - A ban removes a member, revokes their invites by id and the ones they
 *   sent, and withholds the invites to their address, which leaving or being
 *   removed leaves open (#747).
 * - While it stands, an invite to them by id is refused, one to their address
 *   is stored withheld, and no admission lets them in.
 * - Household owners and admins ban, list, change and lift. A household admin
 *   bans only someone with the member or guest role, or a non-member.
 *
 * Actors and rosters are arranged before any of them sends a request, as in
 * `household-invites.spec.ts`: the API caches each user's ability on first use
 * and this process cannot evict it (#256).
 */
describe('household bans (#782)', () => {
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

  const bansRoute = (householdId: string) => `/api/households/${householdId}/bans`;

  const banUser = (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(bansRoute(householdId)).set(actor.headers).send(body);

  const listBans = (actor: SessionActor, householdId: string) =>
    request(baseUrl).get(bansRoute(householdId)).set(actor.headers);

  const changeReason = (actor: Caller, householdId: string, userId: string, body: Record<string, unknown>) =>
    request(baseUrl)
      .patch(`${bansRoute(householdId)}/${userId}`)
      .set(actor.headers)
      .send(body);

  const liftBan = (actor: Caller, householdId: string, userId: string) =>
    request(baseUrl)
      .delete(`${bansRoute(householdId)}/${userId}`)
      .set(actor.headers);

  const invite = (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body);

  const createdInvite = async (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(await invite(actor, householdId, body).expect(201), 'POST /api/households/:id/invites').invite;

  const accept = (actor: AuthenticatedActor, inviteId: string) =>
    request(baseUrl).post(`/api/invites/${inviteId}/accept`).set(actor.headers);

  const storedInvite = (id: string) => db.client.invite.findUniqueOrThrow({ where: { id } });

  const storedBan = (householdId: string, userId: string) =>
    db.client.householdBan.findUnique({ where: { householdId_userId: { householdId, userId } } });

  const membership = (householdId: string, userId: string) =>
    db.client.householdMember.findUnique({ where: { householdId_userId: { householdId, userId } } });

  const verify = (actor: SessionActor) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { emailVerified: true } });

  /** The message a refusal carries, so a surprise reads as a diff rather than as a bare status. */
  const messageOf = (response: { body: unknown }) => (response.body as { message?: unknown } | null)?.message;

  /**
   * Sends the request at once and settles it to its status and message. Not
   * awaited by the caller until the barrier lets go, and handled here, so a
   * failure before then is not an unhandled rejection.
   */
  const send = (pending: request.Test) => {
    const settled = pending.then((response) => ({ status: response.status, message: messageOf(response) ?? null }));
    settled.catch(() => undefined);

    return settled;
  };

  /**
   * A household with an owner, an admin, a member and a guest, under
   * `memberInvitePolicy`, and a second admin when asked for.
   */
  const household = async ({
    memberInvitePolicy,
    secondAdmin = false,
  }: { memberInvitePolicy?: MemberInvitePolicy; secondAdmin?: boolean } = {}) => {
    const [owner, admin, member, guest] = await Promise.all([
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
    ]);
    const otherAdmin = secondAdmin ? await actors.user() : null;
    const { household: created } = await actors.householdWithMembers({
      owner,
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        { actor: member, role: SystemRole.HouseholdMember },
        { actor: guest, role: SystemRole.HouseholdGuest },
        ...(otherAdmin === null ? [] : [{ actor: otherAdmin, role: SystemRole.HouseholdAdmin }]),
      ],
      memberInvitePolicy,
    });

    return { householdId: created.id, owner, admin, member, guest, otherAdmin };
  };

  it("an owner bans a member: they're removed, their invite by id is revoked, and their address invite is withheld", async () => {
    const h = await household();
    await verify(h.member);
    // An invite by id to a current member can't be made through the route;
    // it is the one left over from before another invite admitted them.
    const byId = await arrangeInvite(db.client, {
      inviter: h.owner,
      householdId: h.householdId,
      inviteeId: h.member.user.id,
    });
    // An address may be invited whoever holds it, a member included.
    const byAddress = await createdInvite(h.admin, h.householdId, { inviteeEmail: h.member.user.email });

    const { ban } = banEnvelope(
      await banUser(h.owner, h.householdId, { userId: h.member.user.id }).expect(201),
      'POST /api/households/:id/bans',
    );

    expect(ban).toMatchObject({ user: { id: h.member.user.id }, bannedBy: { id: h.owner.user.id }, reason: null });
    await expect(membership(h.householdId, h.member.user.id)).resolves.toBeNull();
    await expect(storedInvite(byId.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });

    // Still pending to whoever sent it, and unreachable to the banned member.
    await expect(storedInvite(byAddress.id)).resolves.toMatchObject({ status: InviteStatus.Pending, withheld: true });
    await accept(h.member, byAddress.id).expect(404);
    const { invites } = receivedInvitesEnvelope(
      await request(baseUrl).get('/api/invites').set(h.member.headers).expect(200),
      'GET /api/invites',
    );
    expect(invites.map((received) => received.id)).not.toContain(byAddress.id);
  });

  it('after a ban, an invite by id is refused, in words for owners and plain for members', async () => {
    const h = await household({ memberInvitePolicy: MemberInvitePolicy.Direct });
    const stranger = await actors.user();
    await banUser(h.owner, h.householdId, { userId: stranger.user.id }).expect(201);

    const byOwner = await invite(h.owner, h.householdId, { inviteeId: stranger.user.id }).expect(403);
    expect(messageOf(byOwner)).toBe(BANNED_INVITEE);

    // Members can't read the household's bans, so theirs doesn't name one.
    const byMember = await invite(h.member, h.householdId, { inviteeId: stranger.user.id }).expect(403);
    expect(messageOf(byMember)).toBe(REFUSED);

    await expect(
      db.client.invite.count({ where: { householdId: h.householdId, inviteeId: stranger.user.id } }),
    ).resolves.toBe(0);
  });

  it('an invite by address to a banned user is withheld, whatever its case', async () => {
    const h = await household();
    const stranger = await actors.user();
    await banUser(h.owner, h.householdId, { userId: stranger.user.id }).expect(201);

    const created = await createdInvite(h.admin, h.householdId, { inviteeEmail: stranger.user.email.toUpperCase() });

    await expect(storedInvite(created.id)).resolves.toMatchObject({ status: InviteStatus.Pending, withheld: true });
  });

  it('a banned user who reaches an admission is refused, and the invite stays as it was', async () => {
    const h = await household();
    const stranger = await actors.user();
    await banUser(h.owner, h.householdId, { userId: stranger.user.id }).expect(201);
    // The route refuses this invite; arranged directly, it is one that
    // reached the household some other way.
    const arranged = await arrangeInvite(db.client, {
      inviter: h.owner,
      householdId: h.householdId,
      inviteeId: stranger.user.id,
    });

    const response = await accept(stranger, arranged.id).expect(403);

    expect(messageOf(response)).toBe(BANNED_FROM_HOUSEHOLD);
    await expect(storedInvite(arranged.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    await expect(membership(h.householdId, stranger.user.id)).resolves.toBeNull();
  });

  it('an admin bans members, guests and non-members, but not an admin or an owner', async () => {
    const h = await household({ secondAdmin: true });
    const otherAdmin = h.otherAdmin as SessionActor;
    const [stranger, invitedByOwner, invitedByAdmin] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    // What a ban would revoke, so a refused one can be seen to have revoked nothing.
    const ownersInvite = await arrangeInvite(db.client, {
      inviter: h.owner,
      householdId: h.householdId,
      inviteeId: invitedByOwner.user.id,
    });
    const adminsInvite = await arrangeInvite(db.client, {
      inviter: otherAdmin,
      householdId: h.householdId,
      inviteeId: invitedByAdmin.user.id,
    });

    for (const target of [h.member, h.guest, stranger]) {
      await banUser(h.admin, h.householdId, { userId: target.user.id }).expect(201);
    }
    await expect(membership(h.householdId, h.member.user.id)).resolves.toBeNull();
    await expect(membership(h.householdId, h.guest.user.id)).resolves.toBeNull();

    for (const [target, sent] of [
      [otherAdmin, adminsInvite],
      [h.owner, ownersInvite],
    ] as const) {
      const refused = await banUser(h.admin, h.householdId, { userId: target.user.id }).expect(403);

      // In a ban's words, not removal's "delete this resource".
      expect(messageOf(refused)).toBe(BAN_FORBIDDEN);
      await expect(storedBan(h.householdId, target.user.id)).resolves.toBeNull();
      await expect(membership(h.householdId, target.user.id)).resolves.not.toBeNull();
      await expect(storedInvite(sent.id)).resolves.toMatchObject({ status: InviteStatus.Pending });
    }
  });

  it('nobody else may ban, list, change or lift, whether a member, a guest or not in the household', async () => {
    const h = await household();
    const [banned, unbanned, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    await banUser(h.owner, h.householdId, { userId: banned.user.id }).expect(201);

    for (const actor of [h.member, h.guest, stranger]) {
      await banUser(actor, h.householdId, { userId: unbanned.user.id }).expect(403);
      await listBans(actor, h.householdId).expect(403);
      await changeReason(actor, h.householdId, banned.user.id, { reason: 'mine now' }).expect(403);
      await liftBan(actor, h.householdId, banned.user.id).expect(403);
    }

    await expect(storedBan(h.householdId, unbanned.user.id)).resolves.toBeNull();
    await expect(storedBan(h.householdId, banned.user.id)).resolves.toMatchObject({ reason: null });
  });

  it('refuses banning yourself, an unknown user, or a banned user again, and changing or lifting a ban already lifted', async () => {
    const h = await household();
    const stranger = await actors.user();

    await banUser(h.owner, h.householdId, { userId: h.owner.user.id }).expect(400);
    await banUser(h.owner, h.householdId, { userId: 'no-such-user' }).expect(404);

    await banUser(h.owner, h.householdId, { userId: stranger.user.id }).expect(201);
    await banUser(h.owner, h.householdId, { userId: stranger.user.id }).expect(409);

    await liftBan(h.owner, h.householdId, stranger.user.id).expect(200);
    await changeReason(h.owner, h.householdId, stranger.user.id, { reason: 'none' }).expect(404);
    await liftBan(h.owner, h.householdId, stranger.user.id).expect(404);
  });

  // A key scoped to one resource holds its grant only on { id: resourceId },
  // so the ban is asked about by its id, as invite revoke asks about the
  // invite (#164).
  it('a key scoped to one ban changes and lifts that ban, and no other', async () => {
    const h = await household();
    const [first, second] = await Promise.all([actors.user(), actors.user()]);
    await banUser(h.owner, h.householdId, { userId: first.user.id }).expect(201);
    await banUser(h.owner, h.householdId, { userId: second.user.id }).expect(201);
    const scopedTo = await storedBan(h.householdId, first.user.id);
    const key = await mintApiKey(baseUrl, db.client, h.admin, {
      slugs: ['update:household_ban', 'delete:household_ban'],
      resourceType: ResourceType.HouseholdBan,
      resourceId: scopedTo?.id,
    });

    await changeReason(key, h.householdId, second.user.id, { reason: 'not this one' }).expect(403);
    await liftBan(key, h.householdId, second.user.id).expect(403);

    await changeReason(key, h.householdId, first.user.id, { reason: 'this one' }).expect(200);
    await liftBan(key, h.householdId, first.user.id).expect(200);

    await expect(storedBan(h.householdId, first.user.id)).resolves.toBeNull();
    await expect(storedBan(h.householdId, second.user.id)).resolves.toMatchObject({ reason: null });
  });

  it('the owner and admin list the bans newest first, in the pagination envelope', async () => {
    const h = await household();
    const [first, second] = await Promise.all([actors.user(), actors.user()]);
    await banUser(h.owner, h.householdId, { userId: first.user.id, reason: 'first' }).expect(201);
    await banUser(h.admin, h.householdId, { userId: second.user.id }).expect(201);

    for (const actor of [h.owner, h.admin]) {
      const { bans, pagination } = bansPage(
        await listBans(actor, h.householdId).expect(200),
        'GET /api/households/:id/bans',
      );

      expect(bans.map((ban) => ban.user.id)).toEqual([second.user.id, first.user.id]);
      expect(bans[0]).toMatchObject({ reason: null, bannedBy: { id: h.admin.user.id } });
      expect(bans[1]).toMatchObject({ reason: 'first', bannedBy: { id: h.owner.user.id } });
      expect(pagination).toMatchObject({ page: 1, total: 2, totalPages: 1, hasMore: false });
    }
  });

  it("a ban's reason is set, replaced and cleared", async () => {
    const h = await household();
    const stranger = await actors.user();
    await banUser(h.owner, h.householdId, { userId: stranger.user.id }).expect(201);

    for (const reason of ['a', 'b', null]) {
      const { ban } = banEnvelope(
        await changeReason(h.admin, h.householdId, stranger.user.id, { reason }).expect(200),
        'PATCH /api/households/:id/bans/:userId',
      );
      expect(ban.reason).toBe(reason);
    }

    // Clearing it is said with null, so a body that names no reason is refused.
    await changeReason(h.admin, h.householdId, stranger.user.id, {}).expect(400);
    await expect(storedBan(h.householdId, stranger.user.id)).resolves.toMatchObject({ reason: null });
  });

  it('lifting a ban lets an invite by id go out and be accepted, and leaves a withheld invite unreachable', async () => {
    const h = await household();
    const stranger = await actors.user();
    await verify(stranger);
    const byAddress = await createdInvite(h.admin, h.householdId, { inviteeEmail: stranger.user.email });
    await banUser(h.owner, h.householdId, { userId: stranger.user.id }).expect(201);
    await expect(storedInvite(byAddress.id)).resolves.toMatchObject({ withheld: true });

    const { ban } = banEnvelope(
      // Owners and admins both lift bans; the owner's lift is in the refusals above.
      await liftBan(h.admin, h.householdId, stranger.user.id).expect(200),
      'DELETE /api/households/:id/bans/:userId',
    );

    // The ban as it was.
    expect(ban.user.id).toBe(stranger.user.id);
    await expect(storedBan(h.householdId, stranger.user.id)).resolves.toBeNull();

    // Lifting the ban doesn't send what it withheld.
    await accept(stranger, byAddress.id).expect(404);

    const byId = await createdInvite(h.owner, h.householdId, { inviteeId: stranger.user.id });
    acceptEnvelope(await accept(stranger, byId.id).expect(200), 'POST /api/invites/:id/accept');
    await expect(membership(h.householdId, stranger.user.id)).resolves.not.toBeNull();
  });

  it('an accept queued behind a ban is refused', async () => {
    const h = await household();
    const stranger = await actors.user();
    const pending = await createdInvite(h.owner, h.householdId, { inviteeId: stranger.user.id });

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(HOLD_HOUSEHOLD, [h.householdId]);

      const banning = send(banUser(h.owner, h.householdId, { userId: stranger.user.id }));

      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 1,
        description: 'the ban, at the household lock',
      });

      const accepting = send(accept(stranger, pending.id));

      // Behind the ban, which waits on the household row with the lock its
      // share lock conflicts with.
      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 2,
        description: 'the accept, behind the ban',
      });

      await holder.commit();

      expect(await banning).toMatchObject({ status: 201 });
      expect(await accepting).toEqual({ status: 409, message: expect.stringContaining(InviteStatus.Revoked) });
    });

    await expect(membership(h.householdId, stranger.user.id)).resolves.toBeNull();
    await expect(storedInvite(pending.id)).resolves.toMatchObject({ status: InviteStatus.Revoked });
  });
});
