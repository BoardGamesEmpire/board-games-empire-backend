import { InviteStatus, QuotaScope } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor, type SessionActor } from '@bge/testing-e2e';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectBackendsQueuedBehind, expectNotBlocked, withBarrier } from '../support/lock-barrier';
import { bindTemplate, readShippedSql, readShippedValue } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { inviteEnvelope } from './household-invite-wire';
import { SOFT_DELETE_HOUSEHOLD } from './lock-fixtures';

const RESOURCE = 'household_member_count';

/**
 * An accept racing another accept, and racing the household's delete (#163).
 *
 * A race over HTTP alone shows only the interleavings it happened to hit. So
 * the barrier holds a lock the accept needs first, and each test waits until
 * the requests are seen queued behind it before letting go, which fixes the
 * order they reach the database in:
 *
 *  - the member cap's advisory lock, which an accept takes after it has locked
 *    the household and moved the invite, and before it admits anyone. Each
 *    test caps its household generously, since without a row nothing is
 *    locked;
 *  - the household row itself, as the soft delete holds it.
 *
 * Every waiting accept is inside a Prisma interactive transaction on the
 * default 5s budget, so each test lets go as soon as the queue is seen.
 */
describe('household invite accept races', () => {
  const baseUrl = requireBaseUrl(process.env);
  const QUOTA_SERVICE = 'libs/common/quota/src/lib/quota.service.ts';

  const lockStatement = readShippedSql(QUOTA_SERVICE, ['key'], { matching: /pg_advisory_xact_lock/ });

  const keyFormat = readShippedValue(QUOTA_SERVICE, ['resource', 'scope', 'scopeId'], {
    after: 'private advisoryLockKey',
  });

  /** `QuotaService.advisoryLockKey`'s digest for a household's member cap, which `quota-advisory-lock.spec.ts` pins. */
  const memberCapKey = (householdId: string): string =>
    createHash('sha1')
      .update(bindTemplate(keyFormat, [RESOURCE, QuotaScope.Household, householdId]))
      .digest()
      .readBigInt64BE(0)
      .toString();

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

  const createdInvite = async (actor: SessionActor, householdId: string, body: Record<string, unknown>) =>
    inviteEnvelope(
      await request(baseUrl).post(`/api/households/${householdId}/invites`).set(actor.headers).send(body).expect(201),
      'POST /api/households/:id/invites',
    ).invite;

  const verify = (actor: SessionActor) =>
    db.client.user.update({ where: { id: actor.user.id }, data: { emailVerified: true } });

  /** A cap no test reaches, so the accept takes the cap's lock and is never refused by it. */
  const capMembers = (householdId: string) =>
    db.client.quota.create({
      data: { scope: QuotaScope.Household, scopeId: householdId, householdId, resource: RESOURCE, limit: 50n },
    });

  const memberships = (householdId: string, userId: string) =>
    db.client.householdMember.count({ where: { householdId, userId } });

  const inviteStatus = async (id: string) =>
    (await db.client.invite.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  /**
   * Sends the request at once and settles it to its status and message. Not
   * awaited by the caller until the barrier lets go, and handled here, so a
   * failure before then is not an unhandled rejection.
   */
  const send = (pending: request.Test) => {
    const settled = pending.then((response) => ({
      status: response.status,
      message: (response.body as { message?: unknown } | null)?.message ?? null,
    }));
    settled.catch(() => undefined);

    return settled;
  };

  const arranged = async () => {
    const [owner, invitee] = await Promise.all([actors.user(), actors.user()]);
    const { household } = await actors.householdWithMembers({ owner });
    await capMembers(household.id);

    return { owner, invitee, household };
  };

  it('lets one of two accepts of the same invite through, and tells the other it was accepted', async () => {
    const { owner, invitee, household } = await arranged();
    const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(lockStatement.text, [memberCapKey(household.id)]);

      const racing = [send(acceptById(invitee, invite.id)), send(acceptById(invitee, invite.id))];

      // One waits on the cap holding the invite's row; the other waits on
      // that row, behind it.
      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 2,
        description: 'two accepts of one invite',
      });

      await holder.commit();

      const [joined, refused] = (await Promise.all(racing)).sort((left, right) => left.status - right.status);

      expect(joined).toMatchObject({ status: 200 });
      expect(refused).toEqual({ status: 409, message: expect.stringContaining(InviteStatus.Accepted) });
    });

    expect(await memberships(household.id, invitee.user.id)).toBe(1);
  });

  it('lets one of two twin invites through, and leaves the other open', async () => {
    // One person, by id and by their verified address. Each accept moves its
    // own invite, so the two meet only at the roster's unique index.
    const { owner, invitee, household } = await arranged();
    await verify(invitee);
    const byId = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });
    const byAddress = await createdInvite(owner, household.id, { inviteeEmail: invitee.user.email });

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(lockStatement.text, [memberCapKey(household.id)]);

      const racing = [send(acceptById(invitee, byId.id)), send(acceptById(invitee, byAddress.id))];

      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 2,
        description: 'the accepts of two twin invites',
      });

      await holder.commit();

      const [joined, refused] = (await Promise.all(racing)).sort((left, right) => left.status - right.status);

      expect(joined).toMatchObject({ status: 200 });
      expect(refused).toEqual({ status: 409, message: expect.stringContaining(household.id) });
    });

    expect(await memberships(household.id, invitee.user.id)).toBe(1);
    expect([await inviteStatus(byId.id), await inviteStatus(byAddress.id)].sort()).toEqual(
      [InviteStatus.Accepted, InviteStatus.Pending].sort(),
    );
  });

  it('admits nobody to a household whose delete got there first, and holds no invite while it waits', async () => {
    const { owner, invitee, household } = await arranged();
    const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(SOFT_DELETE_HOUSEHOLD, [household.id]);

      const accepting = send(acceptById(invitee, invite.id));

      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 1,
        description: 'the accept, at the household lock',
      });

      // What the delete does next: revoke the household's invites. An accept
      // that had moved the invite before locking the household would hold
      // this row, and the two would deadlock.
      const revoke = holder.issue(
        `UPDATE invites SET status = 'Revoked', responded_at = now() WHERE id = $1 RETURNING id`,
        [invite.id],
        "the delete's revoke",
      );
      await expectNotBlocked(barrier, revoke);

      await holder.commit();

      expect((await accepting).status).toBe(404);
    });

    expect(await memberships(household.id, invitee.user.id)).toBe(0);
    expect(await inviteStatus(invite.id)).toBe(InviteStatus.Revoked);
  });

  it('lets a delete that arrives mid-accept wait, so the member joins a household that was live', async () => {
    const { owner, invitee, household } = await arranged();
    const invite = await createdInvite(owner, household.id, { inviteeId: invitee.user.id });

    await withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await holder.query(lockStatement.text, [memberCapKey(household.id)]);

      const accepting = send(acceptById(invitee, invite.id));

      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 1,
        description: 'the accept, at the member cap',
      });

      const deleting = send(request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers));

      // Behind the accept's share lock on the household row.
      await expectBackendsQueuedBehind(barrier, {
        heldBy: holder.pid,
        count: 2,
        description: 'the delete, behind the accept',
      });

      await holder.commit();

      expect((await accepting).status).toBe(200);
      expect((await deleting).status).toBe(200);
    });

    expect(await memberships(household.id, invitee.user.id)).toBe(1);
    expect(await inviteStatus(invite.id)).toBe(InviteStatus.Accepted);
    const { deletedAt } = await db.client.household.findUniqueOrThrow({ where: { id: household.id } });
    expect(deletedAt).not.toBeNull();
  });
});
