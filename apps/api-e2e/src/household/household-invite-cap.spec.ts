import { FriendshipStatus, InviteStatus, MemberInvitePolicy, QuotaScope, SystemRole } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, withBarrier } from '../support/lock-barrier';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { inviteEnvelope } from './household-invite-wire';

const RESOURCE = 'household_invite_daily_count';

/**
 * How many household invites a day (#279): a quota resource counting, over
 * the last 24 hours, the invites an inviter sent at `User` scope and the
 * invites a household made at `Household` scope. Past a hard cap the create
 * answers 402. A member's invite that waits for approval (#166) is the
 * household's from its approval, so it takes the household's slot then, and
 * the approval answers 402 past the cap.
 *
 * Every invite counts whatever became of it, so withdrawing or revoking one
 * frees no slot, and a withheld one (#278) counts like any other. No row means no cap.
 *
 * Each test caps its own inviter or household with an instance row. A
 * type-level default would cap every other suite's inviters as well.
 */
describe('household invite cap', () => {
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

  const invitesPath = (householdId: string) => `/api/households/${householdId}/invites`;

  const createInvite = (actor: AuthenticatedActor, householdId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(invitesPath(householdId)).set(actor.headers).send(body);

  const address = () => `invitee-${randomUUID()}@example.test`;

  const invite = async (actor: AuthenticatedActor, householdId: string) =>
    inviteEnvelope(
      await createInvite(actor, householdId, { inviteeEmail: address() }).expect(201),
      'POST /api/households/:id/invites',
    ).invite;

  /** A hard cap of `limit` invites a day on one user or one household. */
  const cap = (scope: typeof QuotaScope.User | typeof QuotaScope.Household, scopeId: string, limit: number) =>
    db.client.quota.create({
      data: {
        scope,
        scopeId,
        resource: RESOURCE,
        limit: BigInt(limit),
        householdId: scope === QuotaScope.Household ? scopeId : null,
      },
    });

  const sentBy = (inviter: SessionActor) => db.client.invite.count({ where: { inviterId: inviter.user.id } });

  const ownedHousehold = async () => {
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner });

    return { owner, household };
  };

  it('refuses an inviter past their own cap with 402, naming it, and writes nothing', async () => {
    const { owner, household } = await ownedHousehold();
    await cap(QuotaScope.User, owner.user.id, 2);

    await invite(owner, household.id);
    await invite(owner, household.id);

    const refused = await createInvite(owner, household.id, { inviteeEmail: address() }).expect(402);

    expect(refused.body).toMatchObject({
      resource: RESOURCE,
      scope: QuotaScope.User,
      limit: '2',
      currentUsage: '2',
      attemptedAmount: '1',
    });
    expect(await sentBy(owner)).toBe(2);
  });

  it("caps nobody without a row: another inviter sends past the first one's cap", async () => {
    const capped = await ownedHousehold();
    const uncapped = await ownedHousehold();
    await cap(QuotaScope.User, capped.owner.user.id, 1);

    await invite(capped.owner, capped.household.id);
    await createInvite(capped.owner, capped.household.id, { inviteeEmail: address() }).expect(402);

    for (let sent = 0; sent < 3; sent++) {
      await invite(uncapped.owner, uncapped.household.id);
    }

    expect(await sentBy(uncapped.owner)).toBe(3);
  });

  it("counts a household's invites whoever sent them", async () => {
    const [owner, admin] = await Promise.all([actors.user(), actors.user()]);
    const { household } = await actors.householdWithMembers({
      owner,
      members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
    });
    await cap(QuotaScope.Household, household.id, 2);

    await invite(owner, household.id);
    await invite(admin, household.id);

    const refused = await createInvite(owner, household.id, { inviteeEmail: address() }).expect(402);

    expect(refused.body).toMatchObject({ scope: QuotaScope.Household, limit: '2', currentUsage: '2' });
  });

  describe("a member's invite that waits for approval (#166)", () => {
    const approve = (actor: AuthenticatedActor, householdId: string, inviteId: string) =>
      request(baseUrl)
        .post(`${invitesPath(householdId)}/${inviteId}/approve`)
        .set(actor.headers);

    const status = async (id: string) =>
      (await db.client.invite.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

    const withMember = async () => {
      const [owner, member] = await Promise.all([actors.user(), actors.user()]);
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
        memberInvitePolicy: MemberInvitePolicy.NeedsApproval,
      });

      return { owner, member, household };
    };

    it("takes none of the household's day until it is approved, and is not refused by a full one", async () => {
      const { owner, member, household } = await withMember();
      await cap(QuotaScope.Household, household.id, 1);

      const proposed = await invite(member, household.id);
      expect(proposed.status).toBe(InviteStatus.AwaitingApproval);
      await invite(owner, household.id);

      const another = await invite(member, household.id);
      expect(another.status).toBe(InviteStatus.AwaitingApproval);
      await createInvite(owner, household.id, { inviteeEmail: address() }).expect(402);
    });

    it("still takes one of the member's own day", async () => {
      const { member, household } = await withMember();
      await cap(QuotaScope.User, member.user.id, 1);

      await invite(member, household.id);

      const refused = await createInvite(member, household.id, { inviteeEmail: address() }).expect(402);
      expect(refused.body).toMatchObject({ scope: QuotaScope.User, limit: '1', currentUsage: '1' });
    });

    it("takes the household's slot when approved, and refuses an approval past the cap with 402", async () => {
      const { owner, member, household } = await withMember();
      await cap(QuotaScope.Household, household.id, 1);
      const first = await invite(member, household.id);
      const second = await invite(member, household.id);

      await approve(owner, household.id, first.id).expect(200);
      const refused = await approve(owner, household.id, second.id).expect(402);

      expect(refused.body).toMatchObject({
        resource: RESOURCE,
        scope: QuotaScope.Household,
        limit: '1',
        currentUsage: '1',
        attemptedAmount: '1',
      });
      expect(await status(second.id)).toBe(InviteStatus.AwaitingApproval);
      await createInvite(owner, household.id, { inviteeEmail: address() }).expect(402);
    });
  });

  it('frees no slot when an invite is withdrawn or revoked', async () => {
    const [owner, admin] = await Promise.all([actors.user(), actors.user()]);
    const { household } = await actors.householdWithMembers({
      owner,
      members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
    });
    await cap(QuotaScope.User, owner.user.id, 2);

    const withdrawn = await invite(owner, household.id);
    const revoked = await invite(owner, household.id);
    await request(baseUrl).post(`/api/invites/${withdrawn.id}/withdraw`).set(owner.headers).expect(200);
    await request(baseUrl)
      .post(`${invitesPath(household.id)}/${revoked.id}/revoke`)
      .set(admin.headers)
      .expect(200);

    await createInvite(owner, household.id, { inviteeEmail: address() }).expect(402);
  });

  it('frees no slot when a household delete revokes its invites', async () => {
    const owner = await actors.user();
    const { household: deleted } = await actors.householdWithMembers({ owner });
    const { household: kept } = await actors.householdWithMembers({ owner });
    await cap(QuotaScope.User, owner.user.id, 1);

    const { id } = await invite(owner, deleted.id);
    await request(baseUrl).delete(`/api/households/${deleted.id}`).set(owner.headers).expect(200);
    expect((await db.client.invite.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe(
      InviteStatus.Revoked,
    );

    await createInvite(owner, kept.id, { inviteeEmail: address() }).expect(402);
  });

  it('counts a withheld invite like any other, so the cap cannot tell which it was', async () => {
    const [owner, blocker] = await Promise.all([actors.user(), actors.user()]);
    const { household } = await actors.householdWithMembers({ owner });
    await cap(QuotaScope.User, owner.user.id, 1);
    await db.client.friendship.create({
      data: {
        requesterId: blocker.user.id,
        addresseeId: owner.user.id,
        pairKey: [blocker.user.id, owner.user.id].sort().join(':'),
        status: FriendshipStatus.Blocked,
        respondedAt: new Date(),
      },
    });

    const { invite: withheld } = inviteEnvelope(
      await createInvite(owner, household.id, { inviteeEmail: blocker.user.email }).expect(201),
      'POST /api/households/:id/invites',
    );
    expect(
      (await db.client.invite.findUniqueOrThrow({ where: { id: withheld.id }, select: { withheld: true } })).withheld,
    ).toBe(true);

    await createInvite(owner, household.id, { inviteeEmail: address() }).expect(402);
  });

  it('frees a slot once an invite is a day old', async () => {
    const { owner, household } = await ownedHousehold();
    await cap(QuotaScope.User, owner.user.id, 1);

    const { id } = await invite(owner, household.id);
    await db.client.invite.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    await invite(owner, household.id);
  });

  /**
   * The cap holds when two invites race for its last slot: `consume` takes an
   * advisory lock on the inviter's cap and counts again under it, so the
   * second invite counts the first.
   *
   * A race over HTTP alone shows only the interleavings it happened to hit.
   * Here the barrier holds the inviter's key first, so both invites are seen
   * queued on it before either counts, and then exactly one gets the slot.
   */
  describe('two invites at once', () => {
    const QUOTA_SERVICE = 'libs/common/quota/src/lib/quota.service.ts';

    const lockStatement = readShippedSql(QUOTA_SERVICE, ['key'], { matching: /pg_advisory_xact_lock/ });

    const keyFormat = readShippedValue(QUOTA_SERVICE, ['resource', 'scope', 'scopeId'], {
      after: 'private advisoryLockKey',
    });

    /** `QuotaService.advisoryLockKey`'s digest, which `quota-advisory-lock.spec.ts` pins. */
    const advisoryKey = (scope: string, scopeId: string): string =>
      createHash('sha1')
        .update(bindTemplate(keyFormat, [RESOURCE, scope, scopeId]))
        .digest()
        .readBigInt64BE(0)
        .toString();

    it('lets only one of them take the last slot', async () => {
      const { owner, household } = await ownedHousehold();
      await cap(QuotaScope.User, owner.user.id, 1);

      await withBarrier(async (barrier) => {
        const { holder } = barrier;

        await holder.begin();
        await holder.query(lockStatement.text, [advisoryKey(QuotaScope.User, owner.user.id)]);

        // Not awaited: both are meant to wait on the key. Each is handled at
        // once, so a failure before the await is not an unhandled rejection.
        const racing = [0, 1].map(() => {
          const status = createInvite(owner, household.id, { inviteeEmail: address() }).then(
            (response) => response.status,
          );
          status.catch(() => undefined);

          return status;
        });

        await expectBackendsQueuedBehind(barrier, {
          heldBy: holder.pid,
          count: 2,
          description: 'two invites by the same inviter',
        });

        // Released at once: each waiting create is inside a Prisma interactive
        // transaction on the default 5s budget.
        await holder.commit();

        expect((await Promise.all(racing)).sort()).toEqual([201, 402]);
      });

      expect(await sentBy(owner)).toBe(1);
    });
  });
});
