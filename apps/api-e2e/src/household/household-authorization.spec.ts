import { FriendshipStatus, SystemRole, Visibility } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createEnvelope, listEnvelope, readEnvelope } from './household-wire';

/**
 * The authorization half of #257: what CASL scoping actually admits and denies
 * against real rows, rather than what `accessibleBy` returns as a sentinel
 * object.
 *
 * Two things worth knowing before reading the 403 assertions, because the same
 * status arrives from two different layers:
 *
 *  - On READ, `PoliciesGuard` passes (every `SystemRole.User` holds
 *    `read:households`), the permission-scoped `findUnique` misses, and
 *    `householdExists` then disambiguates: 403 if the row is there, 404 if it
 *    is not.
 *  - On UPDATE and DELETE, a non-member never reaches the service at all.
 *    `update:household` / `delete:household` are carried only by the
 *    `HouseholdOwner` / `HouseholdAdmin` household roles (#160 pinned the role
 *    clause into the condition), so `ability.can(...)` is false and the guard
 *    throws first.
 *
 * Both are asserted. A single status arriving for two unrelated reasons is
 * exactly the arrangement where one path quietly stops holding.
 */
describe('household authorization', () => {
  const baseUrl = requireBaseUrl(process.env);
  const HOUSEHOLDS_PATH = '/api/households';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const listHouseholds = (actor: SessionActor) => request(baseUrl).get(HOUSEHOLDS_PATH).set(actor.headers);

  const listOwnHouseholds = (actor: SessionActor) =>
    request(baseUrl).get(`${HOUSEHOLDS_PATH}/mine`).set(actor.headers);

  /**
   * An accepted friendship, arranged directly (no fixture covers this yet).
   * `pairKey` is the canonical undirected key the model requires the service to
   * maintain — two sorted ids joined — so a row written here is indistinguishable
   * from one the friendship service would have written.
   */
  const befriend = async (a: SessionActor, b: SessionActor) => {
    await db.client.friendship.create({
      data: {
        requesterId: a.user.id,
        addresseeId: b.user.id,
        pairKey: [a.user.id, b.user.id].sort().join(':'),
        status: FriendshipStatus.Accepted,
        respondedAt: new Date(),
      },
    });
  };

  const readHousehold = (actor: SessionActor, id: string) =>
    request(baseUrl).get(`${HOUSEHOLDS_PATH}/${id}`).set(actor.headers);

  const renameHousehold = (actor: SessionActor, id: string, name: string) =>
    request(baseUrl).patch(`${HOUSEHOLDS_PATH}/${id}`).set(actor.headers).send({ name });

  const deleteHousehold = (actor: SessionActor, id: string) =>
    request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${id}`).set(actor.headers);

  describe('reading a household', () => {
    it('admits a member and denies a non-member with 403, not 404', async () => {
      // Actors first, roster before any of them issues an authenticated
      // request: the ability cache populates lazily per user and the test
      // process cannot evict it (#256 ordering rule, #272).
      const owner = await actors.user();
      const member = await actors.user();
      const outsider = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Readable household',
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      const asOwner = await readHousehold(owner, fixture.household.id).expect(200);
      expect(readEnvelope(asOwner, 'GET /api/households/:id as owner').household.id).toBe(fixture.household.id);

      await readHousehold(member, fixture.household.id).expect(200);

      // The disambiguation this issue exists to settle: the household is there,
      // the actor may not see it. 404 here would be defensible as
      // information-hiding, but it is not what the service does, and an
      // unasserted choice is one that changes by accident.
      await readHousehold(outsider, fixture.household.id).expect(403);
    });

    it('answers 404 for an id that does not exist', async () => {
      const actor = await actors.user();

      // `Household.id` has no wire-level format validation, so any string
      // reaches the scoped lookup — which is the path under test.
      await readHousehold(actor, `missing-${randomUUID()}`).expect(404);
    });

    // Titled for what it actually pins. This read is NOT membership-scoped: a
    // plain user also receives friends' `Friends`-visible households, and these
    // two actors are strangers, so the union simply never arises here. The
    // membership-scoped read and the friends case are covered below (#364).
    it('scopes the list to what the actor may read, and a non-member sees absence', async () => {
      const owner = await actors.user();
      const outsider = await actors.user();

      const fixture = await actors.householdWithMembers({ owner, name: 'Not yours' });

      const ownList = listEnvelope(await listHouseholds(owner).expect(200), 'GET /api/households as owner');
      expect(ownList.households.map((household) => household.id)).toEqual([fixture.household.id]);
      // #230: `total` is scoped like the rows, so it counts the actor's page set
      // rather than every household on the server.
      expect(ownList.pagination).toMatchObject({ page: 1, total: 1, totalPages: 1, hasMore: false });

      // The same rule that yields 403 on the detail route yields absence here:
      // a scoped `findMany` has no existence probe to disambiguate against, so
      // an unauthorized household is simply not in the page.
      const outsiderList = listEnvelope(await listHouseholds(outsider).expect(200), 'GET /api/households as outsider');
      expect(outsiderList.households).toEqual([]);
      expect(outsiderList.pagination).toMatchObject({ total: 0, totalPages: 0, hasMore: false });
    });
  });

  /**
   * #364. `GET /households` answers a different question depending on who asks;
   * `GET /households/mine` answers the same one for everybody. These four tests
   * are the difference — each one passes trivially against the role-widened
   * read, EXCEPT against the thing it is actually pinning.
   */
  describe('the membership-scoped list', () => {
    it('gives an elevated caller only their own memberships, where the wide list gives them everything', async () => {
      // Rosters before anyone's first authenticated request (the ordering rule).
      const admin = await actors.admin();
      const stranger = await actors.user();

      const belongsToAdmin = await actors.householdWithMembers({ owner: admin, name: 'The admin lives here' });
      const belongsToNobodyRelevant = await actors.householdWithMembers({
        owner: stranger,
        name: 'Nothing to do with the admin',
      });

      const scoped = listEnvelope(await listOwnHouseholds(admin).expect(200), 'GET /api/households/mine as admin');
      expect(scoped.households.map((household) => household.id)).toEqual([belongsToAdmin.household.id]);
      expect(scoped.pagination).toMatchObject({ page: 1, total: 1, totalPages: 1, hasMore: false });

      // The control. Without this the test above would also pass if `/mine` had
      // simply been wired to the widened read on a server with one household.
      const wide = listEnvelope(await listHouseholds(admin).expect(200), 'GET /api/households as admin');
      expect(wide.households.map((household) => household.id)).toEqual(
        expect.arrayContaining([belongsToAdmin.household.id, belongsToNobodyRelevant.household.id]),
      );
      expect(wide.pagination.total).toBeGreaterThan(scoped.pagination.total);
    });

    it("omits a friend's Friends-visible household, which the wide list includes", async () => {
      // The case `pagination.total` cannot detect at all: this household is in
      // an ordinary user's list with no membership behind it, so a client
      // treating absence as removal would be wrong about a household it never
      // belonged to. D-364-2 is what excludes it.
      const friend = await actors.user();
      const viewer = await actors.user();

      const shared = await actors.householdWithMembers({ owner: friend, name: 'Visible to friends' });
      await db.client.household.update({
        where: { id: shared.household.id },
        data: { visibility: Visibility.Friends },
      });
      await befriend(viewer, friend);

      const wide = listEnvelope(await listHouseholds(viewer).expect(200), 'GET /api/households as a friend');
      expect(wide.households.map((household) => household.id)).toEqual([shared.household.id]);

      const scoped = listEnvelope(await listOwnHouseholds(viewer).expect(200), 'GET /api/households/mine as a friend');
      expect(scoped.households).toEqual([]);
      expect(scoped.pagination).toMatchObject({ total: 0, totalPages: 0, hasMore: false });
    });

    it('omits a soft-deleted household even though the caller\u2019s member row survives it', async () => {
      // D-364-5. `deleteHousehold` retains member rows by design, so the
      // membership clause on its own still matches a dead household — the
      // member row is asserted precisely so this cannot be mistaken for a
      // fixture that tore itself down.
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner, name: 'About to be deleted' });

      await deleteHousehold(owner, fixture.household.id).expect(200);

      const survivingMembership = await db.client.householdMember.findFirst({
        where: { householdId: fixture.household.id, userId: owner.user.id },
        select: { id: true },
      });
      expect(survivingMembership).not.toBeNull();

      const scoped = listEnvelope(
        await listOwnHouseholds(owner).expect(200),
        'GET /api/households/mine after a soft delete',
      );
      expect(scoped.households).toEqual([]);
      expect(scoped.pagination).toMatchObject({ total: 0, totalPages: 0, hasMore: false });
    });

    it('is reachable at all, rather than captured by the :id detail route', async () => {
      // Nest matches in declaration order. With `@Get(':id')` declared first,
      // every request here becomes a household lookup for the literal id
      // "mine" — a 404, or worse a 200 carrying the detail shape.
      const actor = await actors.user();

      const response = await listOwnHouseholds(actor).expect(200);

      expect(response.body).toHaveProperty('households');
      expect(response.body).toHaveProperty('pagination');
      expect(response.body).not.toHaveProperty('household');
    });
  });

  describe('updating a household', () => {
    it('lets an owner rename it', async () => {
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner, name: 'Before' });

      const response = await renameHousehold(owner, fixture.household.id, 'After').expect(200);
      expect(createEnvelope(response, 'PATCH /api/households/:id').household.name).toBe('After');

      const persisted = await db.client.household.findUniqueOrThrow({ where: { id: fixture.household.id } });
      expect(persisted.name).toBe('After');
    });

    it('denies a plain member, whose household role carries no update grant', async () => {
      const owner = await actors.user();
      const member = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Members cannot rename this',
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      await renameHousehold(member, fixture.household.id, 'Renamed by a member').expect(403);

      const persisted = await db.client.household.findUniqueOrThrow({ where: { id: fixture.household.id } });
      expect(persisted.name).toBe('Members cannot rename this');
    });

    it('denies a non-member with 403 rather than 404, and denies before reaching the service', async () => {
      const owner = await actors.user();
      const outsider = await actors.user();
      const fixture = await actors.householdWithMembers({ owner, name: 'Untouchable' });

      await renameHousehold(outsider, fixture.household.id, 'Renamed by an outsider').expect(403);

      // The guard denies on the ability alone, so a household that does not
      // exist gets the same 403 — the existence probe in `updateHousehold` is
      // never reached. Asserting it pins where the boundary actually is: a
      // future change moving the check into the service would turn this into a
      // 404 and change what an attacker can learn about which ids exist.
      await renameHousehold(outsider, `missing-${randomUUID()}`, 'Renamed').expect(403);
    });
  });

  describe('deleting a household', () => {
    it('is owner-only: a HouseholdAdmin is excluded along with plain members', async () => {
      // `delete:household` is one of the two slugs explicitly withheld from the
      // derived HouseholdAdmin list (the other being ownership transfer). The
      // Admin case is the one worth asserting: the list is derived by
      // subtraction, so a slug added to the owner list without being named in
      // `disallowedHouseholdAdminPermissions` reaches Admin silently.
      const owner = await actors.user();
      const admin = await actors.user();
      const member = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Owner-only delete',
        members: [
          { actor: admin, role: SystemRole.HouseholdAdmin },
          { actor: member, role: SystemRole.HouseholdMember },
        ],
      });

      await deleteHousehold(admin, fixture.household.id).expect(403);
      await deleteHousehold(member, fixture.household.id).expect(403);

      const stillThere = await db.client.household.findUniqueOrThrow({ where: { id: fixture.household.id } });
      expect(stillThere.deletedAt).toBeNull();

      await deleteHousehold(owner, fixture.household.id).expect(200);
    });

    it('lets a HouseholdAdmin rename what it may not delete', async () => {
      // The complement of the case above, and the reason the Admin denial is
      // about `delete` specifically rather than about Admins generally.
      const owner = await actors.user();
      const admin = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Admin may rename',
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });

      await renameHousehold(admin, fixture.household.id, 'Renamed by an admin').expect(200);
    });
  });

  /**
   * The pair below is a matched control. Both make the same `PATCH` with the
   * same household role; the only difference is whether anything evicted the
   * actor's cached ability graph between the grant and the request. One asserts
   * that the server-side eviction works, the other that nothing else provides
   * it.
   */
  describe('the ability cache', () => {
    it('resolves a creator new HouseholdOwner grants on their next request', async () => {
      // #257. Note what this does NOT assert: a GET would return 200
      // whether or not eviction happened, because `read:households` lives on
      // the base User role with a `members.some.userId` condition that
      // `accessibleBy` renders into a Prisma WHERE evaluated against live rows.
      // Only a grant carried SOLELY by the HouseholdOwner household role makes
      // the cache observable, and `update:household` is that grant.
      const actor = await actors.user();

      // The POST is this actor's first authenticated request, so it populates
      // the graph cache with no household in it. `HouseholdService.create` then
      // calls `permissions.invalidateUser`.
      const created = createEnvelope(
        await request(baseUrl).post(HOUSEHOLDS_PATH).set(actor.headers).send({ name: 'Mine now' }).expect(201),
        'POST /api/households',
      );

      // Persisted ownership, as the issue asked: a real HouseholdMember row
      // carrying the HouseholdOwner role.
      const member = await db.client.householdMember.findFirstOrThrow({
        where: { householdId: created.household.id, userId: actor.user.id },
        select: { id: true },
      });
      const householdRole = await db.client.householdRole.findUniqueOrThrow({
        where: { householdMemberId: member.id },
        select: { role: { select: { name: true } } },
      });
      expect(householdRole.role.name).toBe(SystemRole.HouseholdOwner);

      // ...and the grants actually resolve. Without the eviction this is a 403
      // for the full 5-minute graph TTL.
      await renameHousehold(actor, created.household.id, 'Renamed by its creator').expect(200);
    });

    it('does not see a membership arranged after the actor first authenticated (#272)', async () => {
      // CHARACTERIZATION TEST. This pins a known limitation, not desired
      // behaviour: the ordering rule in `createHouseholdWithMembers` exists
      // because nothing evicts a graph the test process arranged around, and
      // #272 tracks whether that needs enforcing. When #272 is resolved this
      // assertion flips to 200 — do not "fix" it in the meantime by deleting
      // the test, which would remove the only signal that the rule is real.
      //
      // It also documents why the rule is dangerous rather than merely
      // inconvenient: on read paths a violation is invisible (live-row
      // conditions bypass the cache), and here it is a bare 403 that looks
      // exactly like a genuine denial.
      const actor = await actors.user();

      // First authenticated request: the graph is cached with no household.
      await listHouseholds(actor).expect(200);

      const fixture = await actors.householdWithMembers({ owner: actor, name: 'Arranged too late' });

      await renameHousehold(actor, fixture.household.id, 'Renamed with a stale graph').expect(403);

      // The rows are right; only the cache is stale. Asserted so a future
      // reader cannot mistake this for a fixture that failed to arrange.
      const householdRole = await db.client.householdRole.findUniqueOrThrow({
        where: { householdMemberId: fixture.owner.member.id },
        select: { role: { select: { name: true } } },
      });
      expect(householdRole.role.name).toBe(SystemRole.HouseholdOwner);
    });
  });
});
