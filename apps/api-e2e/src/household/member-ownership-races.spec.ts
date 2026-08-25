import { SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The product half of #239: concurrent owner transitions issued as real HTTP
 * requests, asserting the INVARIANT rather than the interleaving.
 *
 * The barrier specs beside this one prove the lock's mechanism — that the
 * statement blocks. They cannot show that the endpoints take it on the paths
 * that matter, and a lock that is correct but unreached protects nothing. This
 * spec answers the other half: whatever order the two requests land in, a
 * household never ends up ownerless, and never ends up with an owner who
 * already gave the role away.
 *
 * On probabilism, since it is the obvious objection: hitting a precise
 * interleaving is chancy, but every assertion here holds under ALL of them.
 * That makes a pass meaningful in one direction — reverting the lock makes
 * these fail whenever the race is hit, rather than making them flaky in the
 * other direction, because the states asserted against are unreachable while
 * the guard holds.
 *
 * `maxWorkers: 1` bounds test-level parallelism, not request-level concurrency
 * within a test (#210's idempotency spec relies on the same distinction).
 */
describe('concurrent household owner transitions', () => {
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

  const membersPath = (householdId: string): string => `/api/households/${householdId}/members`;

  const leave = (actor: SessionActor, householdId: string) =>
    request(baseUrl)
      .delete(`${membersPath(householdId)}/me`)
      .set(actor.headers);

  const transferOwnership = (actor: SessionActor, householdId: string, memberId: string) =>
    request(baseUrl)
      .post(`${membersPath(householdId)}/${memberId}/transfer-ownership`)
      .set(actor.headers);

  const ownerCount = (householdId: string): Promise<number> =>
    db.client.householdRole.count({
      where: { householdMember: { householdId }, role: { name: SystemRole.HouseholdOwner } },
    });

  const memberCount = (householdId: string): Promise<number> =>
    db.client.householdMember.count({ where: { householdId } });

  /** Status plus message, so a surprise reads as a diff rather than as `500`. */
  const outcome = (response: { status: number; body: unknown }) => ({
    status: response.status,
    message: (response.body as { message?: unknown } | null)?.message ?? null,
  });

  /** Sorted by status, so an assertion does not pin which request won. */
  const outcomes = (responses: readonly { status: number; body: unknown }[]) =>
    responses.map(outcome).sort((left, right) => left.status - right.status);

  it('lets exactly one of two simultaneous owner departures through', async () => {
    // #157's original race, end to end. Under READ COMMITTED without the lock
    // both transactions read two owners, both conclude another owner remains,
    // and the household is left ownerless with no error raised anywhere.
    const first = await actors.user();
    const second = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner: first,
      name: 'Two owners, both leaving',
      members: [{ actor: second, role: SystemRole.HouseholdOwner }],
    });

    const responses = await Promise.all([leave(first, fixture.household.id), leave(second, fixture.household.id)]);

    // Asserted rather than `.expect()`-chained: a 500 should report itself,
    // not arrive as an unhandled rejection from a chained expectation.
    const [allowed, refused] = outcomes(responses);

    expect([allowed, refused]).toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 400 }),
    ]);

    // The refusal names the household and points at the way out of it.
    expect(refused.message).toContain(fixture.household.id);
    expect(refused.message).toMatch(/transfer ownership/i);

    await expect(ownerCount(fixture.household.id)).resolves.toBe(1);
    await expect(memberCount(fixture.household.id)).resolves.toBe(1);
  });

  it('lets exactly one of an owner’s two simultaneous transfers through', async () => {
    // The transfer path's own race, and #248's reason for deciding from the
    // LOCKED set rather than from a pre-lock read: unserialized, both
    // transactions see the actor as owner, both demote it, and both promote
    // their own target — leaving two owners and an actor who has already given
    // the role away.
    const owner = await actors.user();
    const [firstTarget, secondTarget] = [await actors.user(), await actors.user()];

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'One owner, two transfers',
      members: [
        { actor: firstTarget, role: SystemRole.HouseholdMember },
        { actor: secondTarget, role: SystemRole.HouseholdMember },
      ],
    });

    const [firstMember, secondMember] = fixture.members;

    const responses = await Promise.all([
      transferOwnership(owner, fixture.household.id, firstMember.member.id),
      transferOwnership(owner, fixture.household.id, secondMember.member.id),
    ]);

    // 201 because the route is a POST (Nest's default for one), and 403 rather
    // than 400 for the loser: its authority is re-derived from the locked owner
    // set, and by then it is no longer an owner.
    expect(outcomes(responses)).toEqual([
      expect.objectContaining({ status: 201 }),
      expect.objectContaining({ status: 403 }),
    ]);

    await expect(ownerCount(fixture.household.id)).resolves.toBe(1);

    // ...and the one owner is a target, never the actor that transferred away.
    const owners = await db.client.householdRole.findMany({
      where: { householdMember: { householdId: fixture.household.id }, role: { name: SystemRole.HouseholdOwner } },
      select: { householdMember: { select: { userId: true } } },
    });

    expect(owners.map((row) => row.householdMember.userId)).not.toContain(owner.user.id);
  });

  it('keeps an owner when a role change races the transfer that promotes its target', async () => {
    // The same defect one endpoint over. `updateMemberRole` refuses to touch an
    // owner, but it used to decide that from a pre-lock read: an admin
    // demoting a plain member, racing an owner transferring to that same
    // member, would overwrite the household's brand-new owner back down and
    // leave nobody holding the role.
    const owner = await actors.user();
    const admin = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Role change racing a promotion',
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        { actor: member, role: SystemRole.HouseholdMember },
      ],
    });

    const target = fixture.members[1];

    const [transfer, roleChange] = await Promise.all([
      transferOwnership(owner, fixture.household.id, target.member.id),
      request(baseUrl)
        .patch(`${membersPath(fixture.household.id)}/${target.member.id}/role`)
        .set(admin.headers)
        .send({ role: SystemRole.HouseholdGuest }),
    ]);

    // The transfer succeeds under BOTH orderings — promoting a guest is as
    // legal as promoting a member — so it is the role change that reports which
    // one happened, and branching on the transfer would assert nothing.
    expect(outcome(transfer)).toMatchObject({ status: 201 });

    if (roleChange.status === 400) {
      // The promotion landed first, so the role change is now aimed at an owner
      // and is refused. This is the arm the household lock exists for: without
      // it the change would have overwritten the new owner back down.
      expect(outcome(roleChange)).toMatchObject({ status: 400 });
    } else {
      // The demotion landed first; the transfer then promoted a guest.
      expect(outcome(roleChange)).toMatchObject({ status: 200 });
    }

    await expect(ownerCount(fixture.household.id)).resolves.toBe(1);
  });

  it('keeps an owner when a departure races the transfer that promotes the departing member', async () => {
    // The case most worth having, and the exact race #157's conditional lock
    // got wrong: the lock used to be gated on a PRE-LOCK read of the leaving
    // member's role, so a member promoted to owner between that read and the
    // commit was deleted with the last-owner check skipped entirely. Ownerless
    // household, no error raised, nothing in the logs.
    const owner = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Departure racing a promotion',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });

    const [promoted] = fixture.members;

    const [transfer, departure] = await Promise.all([
      transferOwnership(owner, fixture.household.id, promoted.member.id),
      leave(member, fixture.household.id),
    ]);

    // Both orderings are legitimate; what is not legitimate is both winning.
    // Stated as a correlation rather than as a status pair, because either
    // ordering is a correct outcome and the suite must not pin the scheduler.
    if (departure.status === 200) {
      // The member left first, so the promotion had no one to promote.
      expect(outcome(transfer)).toMatchObject({ status: 404 });
      await expect(memberCount(fixture.household.id)).resolves.toBe(1);
    } else {
      // The promotion landed first, so the departure is now the last owner's.
      expect(outcome(transfer)).toMatchObject({ status: 201 });
      expect(outcome(departure)).toMatchObject({ status: 400, message: expect.stringMatching(/transfer ownership/i) });
      await expect(memberCount(fixture.household.id)).resolves.toBe(2);
    }

    await expect(ownerCount(fixture.household.id)).resolves.toBe(1);
  });
});
