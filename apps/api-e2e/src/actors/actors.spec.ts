import { SystemRole } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { resetDatabase } from '../support/database-reset';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * Acceptance for the actor fixtures (#256). The factories' unit specs cover
 * their pure logic; everything here is what only a running server and a
 * real database can prove — the signup wire path, asynchronous provisioning,
 * the first-human-becomes-Owner sentinel, and credentials the authorization
 * layer actually accepts.
 *
 * Household BEHAVIOR (idempotency, 403-vs-404 disambiguation, soft-delete
 * visibility) is deliberately not asserted here — that is #257's suite.
 * This file proves the fixtures those assertions will stand on.
 */
describe('actor fixtures (#256)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    // One instance for the whole file: the Owner-sentinel memo self-validates
    // against the database, so the per-test truncate sweep is survivable.
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * Every GLOBAL role the user holds, sorted. `UserRole` carries global roles
   * only — household roles live on `HouseholdRole` (keyed on the membership
   * row) and event roles on `EventAttendeeRole` — so this is the whole global
   * picture and nothing else.
   */
  const globalRoleNames = async (userId: string): Promise<string[]> =>
    (
      await db.client.userRole.findMany({
        where: { userId },
        select: { role: { select: { name: true } } },
      })
    )
      .map((userRole) => userRole.role.name)
      .sort();

  describe('the Owner sentinel', () => {
    it('mints the first human through the real signup path with both role rows and its provisioning side effects', async () => {
      const owner = await actors.owner();

      // The credential works over the wire.
      const response = await request(baseUrl).get('/api/households').set(owner.headers);
      expect(response.status).toBe(200);

      // Provisioning ran to completion: roles, profile, preferences. Both role
      // rows, because elevation is additive (#410) — `manage:all` sits on top
      // of an independently-held base rather than replacing it, so dropping
      // the `Owner` row would leave an ordinary user's ABILITIES behind rather
      // than less than one. That is a property of the ability layer only: the
      // better-auth `user.role` column asserted below is a separate elevation
      // channel with no base beneath it, and whether it survives at all is
      // #422's question, not this issue's.
      await expect(globalRoleNames(owner.user.id)).resolves.toEqual([SystemRole.Owner, SystemRole.User].sort());

      await expect(db.client.userProfile.count({ where: { userId: owner.user.id } })).resolves.toBe(1);
      await expect(db.client.userPreferences.count({ where: { userId: owner.user.id } })).resolves.toBe(1);

      // The Owner-specific provisioning branch ran.
      expect(owner.user.emailVerified).toBe(true);
      expect(owner.user.role).toBe(SystemRole.Admin.toLowerCase());
    });

    it('is memoized: repeated calls return the same persisted user', async () => {
      const first = await actors.owner();
      const second = await actors.owner();

      expect(second.user.id).toBe(first.user.id);
      await expect(db.client.user.count({ where: { isServiceAccount: false } })).resolves.toBe(1);
    });

    it('re-mints after the isolation sweep truncated the memoized sentinel', async () => {
      const before = await actors.owner();
      // The sweep normally runs between tests; invoked inline so this test
      // observes both sides of the boundary with the real truncate semantics.
      await resetDatabase(db.client, db.schema);

      const after = await actors.owner();

      expect(after.user.id).not.toBe(before.user.id);
      await expect(globalRoleNames(after.user.id)).resolves.toEqual([SystemRole.Owner, SystemRole.User].sort());
    });

    it('refuses the Owner seat when a human user already exists, loudly', async () => {
      await db.client.user.create({
        data: { username: 'e2e-preexisting-human', email: 'preexisting@e2e.invalid' },
      });

      await expect(actors.owner()).rejects.toThrow(/Owner seat is taken/);
    });
  });

  describe('role-scoped actors', () => {
    it('provisions subsequent actors as plain Users, with the sentinel absorbing the Owner seat implicitly', async () => {
      // No explicit owner() call — user() must ensure the sentinel itself.
      const user = await actors.user();

      // The base role alone — no elevation on top.
      await expect(globalRoleNames(user.user.id)).resolves.toEqual([SystemRole.User]);

      // Exactly one Owner exists and it is not this actor.
      const owners = await db.client.userRole.findMany({
        where: { role: { name: SystemRole.Owner } },
        select: { userId: true },
      });
      expect(owners).toHaveLength(1);
      expect(owners[0].userId).not.toBe(user.user.id);
    });

    it('authenticates over the wire where the bare route rejects', async () => {
      const user = await actors.user();

      await request(baseUrl).get('/api/households').set(user.headers).expect(200);
      await request(baseUrl).get('/api/households').expect(401);
    });

    it('grants a server-scope admin the Admin catalog role additively', async () => {
      const admin = await actors.admin();

      await expect(globalRoleNames(admin.user.id)).resolves.toEqual([SystemRole.Admin, SystemRole.User].sort());
    });
  });

  describe('householdWithMembers', () => {
    it('arranges a roster the authorization layer then honors on first request', async () => {
      const owner = await actors.user();
      const member = await actors.user();
      const outsider = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'e2e-roster-household',
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      // Persisted shape: owner member carries HouseholdOwner, roster in order.
      const ownerRole = await db.client.householdRole.findUnique({
        where: { householdMemberId: fixture.owner.member.id },
        select: { role: { select: { name: true } } },
      });
      expect(ownerRole?.role.name).toBe(SystemRole.HouseholdOwner);
      expect(fixture.owner.member.userId).toBe(owner.user.id);
      expect(fixture.members).toHaveLength(1);
      expect(fixture.members[0].member.userId).toBe(member.user.id);

      // Over the wire: both roster actors' FIRST authenticated requests see
      // the membership — the ordering rule (arrange before first request)
      // holding end-to-end, ability cache included.
      const asOwner = await request(baseUrl).get(`/api/households/${fixture.household.id}`).set(owner.headers);
      expect(asOwner.status).toBe(200);

      const asMember = await request(baseUrl).get(`/api/households/${fixture.household.id}`).set(member.headers);
      expect(asMember.status).toBe(200);

      // The negative actor: authenticated (so not 401) but not a member.
      // WHICH of 403/404 is correct is #257's disambiguation case; here only
      // "cleanly denied, and not for lack of a credential" is pinned.
      const asOutsider = await request(baseUrl).get(`/api/households/${fixture.household.id}`).set(outsider.headers);
      expect([403, 404]).toContain(asOutsider.status);
    });

    it('rejects a roster that repeats a user before touching the database', async () => {
      const owner = await actors.user();

      await expect(
        actors.householdWithMembers({
          owner,
          members: [{ actor: owner, role: SystemRole.HouseholdMember }],
        }),
      ).rejects.toThrow(/at most once per household/);

      await expect(db.client.household.count()).resolves.toBe(0);
    });
  });
});
