import { SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { adminListEnvelope, type ListAdminHouseholdsEnvelope } from './household-wire';

/**
 * The staff households list, `GET /api/admin/households` (#419), against the
 * running server.
 *
 * It answers every household on the server to staff and the Owner, and a 403
 * to everyone else, whatever households they belong to. The between-test sweep
 * empties the database, so a test's households are the only ones there; each
 * test still names its households with a token of its own and reads with
 * `q=<token>`, which keeps every read to the households the test means and
 * exercises the search on the way.
 */
describe('staff households list (#419)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const ADMIN_HOUSEHOLDS_PATH = '/api/admin/households';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const newToken = () => `adm-${randomUUID().slice(0, 8)}`;

  const list = (actor: SessionActor, query: Record<string, string>) =>
    request(baseUrl).get(ADMIN_HOUSEHOLDS_PATH).query(query).set(actor.headers);

  const listed = async (actor: SessionActor, query: Record<string, string>): Promise<ListAdminHouseholdsEnvelope> =>
    adminListEnvelope(await list(actor, query).expect(200), `GET ${ADMIN_HOUSEHOLDS_PATH}`);

  const idsOf = (page: ListAdminHouseholdsEnvelope) => page.households.map((household) => household.id);

  const household = async (owner: SessionActor, name: string, members: SessionActor[] = []) =>
    (
      await actors.householdWithMembers({
        owner,
        name,
        members: members.map((actor) => ({ actor, role: SystemRole.HouseholdMember })),
      })
    ).household;

  const removeHousehold = (owner: SessionActor, id: string) =>
    request(baseUrl).delete(`/api/households/${id}`).set(owner.headers).expect(200);

  const setDisplayName = (actor: SessionActor, displayName: string | null) =>
    db.client.userProfile.update({ where: { userId: actor.user.id }, data: { displayName } });

  it('answers Admin, Moderator and the Owner with households none of them belong to', async () => {
    const token = newToken();
    const founder = await actors.user();
    const { id } = await household(founder, `${token} Game Night`);

    const staff = [await actors.admin(), await actors.moderator()];

    for (const actor of [...staff, await actors.owner()]) {
      expect(idsOf(await listed(actor, { q: token }))).toEqual([id]);
    }
  });

  // Not a narrowed 200 of their own households: a client reads the 403 as
  // "this section is not yours" and leaves it (client#683). The gate asks for
  // read on every resource, which a household owner never holds.
  it('refuses a user with only the base role with 403, even one who belongs to a matching household', async () => {
    const token = newToken();
    const founder = await actors.user();
    await household(founder, `${token} Game Night`);

    await list(founder, { q: token }).expect(403);
  });

  // "Nothing else" is adminListEnvelope's exact-keys check, which every
  // listed() response passes through; this test pins the values.
  it('returns the row and nothing else: owners, not the roster', async () => {
    const token = newToken();
    const [owner, coOwner, member] = [await actors.user(), await actors.user(), await actors.user()];
    const fixture = await actors.householdWithMembers({
      owner,
      name: `${token} Game Night`,
      members: [
        { actor: coOwner, role: SystemRole.HouseholdOwner },
        { actor: member, role: SystemRole.HouseholdMember },
      ],
    });
    await setDisplayName(owner, 'Ann the Founder');
    await setDisplayName(coOwner, null);
    // The fixture writes both memberships within a millisecond or so, and the
    // owners come in join order, so the co-owner joins a second later here.
    const ownerJoined = fixture.owner.member.createdAt;
    await db.client.householdMember.update({
      where: { householdId_userId: { householdId: fixture.household.id, userId: coOwner.user.id } },
      data: { createdAt: new Date(ownerJoined.getTime() + 1_000) },
    });

    const [row] = (await listed(await actors.admin(), { q: token })).households;

    expect(row.id).toBe(fixture.household.id);
    expect(row.memberCount).toBe(3);
    expect(row.owners).toEqual([
      { userId: owner.user.id, username: owner.user.username, displayName: 'Ann the Founder' },
      { userId: coOwner.user.id, username: coOwner.user.username, displayName: null },
    ]);
  });

  it('lists live households by default, and deleted ones under status=deleted or all', async () => {
    const token = newToken();
    const founder = await actors.user();
    const live = await household(founder, `${token} Still Here`);
    const gone = await household(founder, `${token} Gone`);
    await removeHousehold(founder, gone.id);
    const admin = await actors.admin();

    expect(idsOf(await listed(admin, { q: token }))).toEqual([live.id]);

    const deleted = await listed(admin, { q: token, status: 'deleted' });
    expect(idsOf(deleted)).toEqual([gone.id]);
    expect(deleted.households[0].deletedAt).not.toBeNull();

    expect(idsOf(await listed(admin, { q: token, status: 'all' })).sort()).toEqual([live.id, gone.id].sort());
  });

  // Memberships survive a delete, so the owners staff see are the ones a
  // restore would hand the household back to.
  it('keeps a deleted household’s owners as they stood at the delete', async () => {
    const token = newToken();
    const [owner, coOwner] = [await actors.user(), await actors.user()];
    const fixture = await actors.householdWithMembers({
      owner,
      name: `${token} Gone`,
      members: [{ actor: coOwner, role: SystemRole.HouseholdOwner }],
    });
    await removeHousehold(owner, fixture.household.id);

    const [row] = (await listed(await actors.admin(), { q: token, status: 'deleted' })).households;

    expect(row.id).toBe(fixture.household.id);
    expect(row.memberCount).toBe(2);
    expect(row.owners.map((entry) => entry.userId).sort()).toEqual([owner.user.id, coOwner.user.id].sort());
  });

  it('finds a household by name, member username or member display name, case-insensitively, and lists it once', async () => {
    const token = newToken();
    const founder = await actors.user();
    const [memberA, memberB] = [
      await actors.user({ username: `${token}-a` }),
      await actors.user({ username: `${token}-b` }),
    ];
    const shown = await actors.user();
    await setDisplayName(shown, `Shown ${token}`);

    const byName = await household(founder, `${token} Night`);
    const byUsername = await household(founder, 'Tuesday Group', [memberA]);
    const byDisplayName = await household(founder, 'Friday Group', [shown]);
    // Its name and two of its members match: still one row.
    const byAll = await household(founder, `The ${token} Club`, [memberA, memberB]);
    await household(founder, 'Nobody Matches');

    const page = await listed(await actors.admin(), { q: token.toUpperCase() });

    expect(idsOf(page).sort()).toEqual([byName.id, byUsername.id, byDisplayName.id, byAll.id].sort());
    expect(page.pagination.total).toBe(4);
  });

  it('answers a search that matches nothing with an empty page', async () => {
    const token = newToken();
    await household(await actors.user(), `${token} Night`);

    const page = await listed(await actors.admin(), { q: `${token}-nothing` });

    expect(page.households).toEqual([]);
    expect(page.pagination.total).toBe(0);
  });

  // Unescaped, `%` and `_` are LIKE wildcards: `100%` would match `100x` and
  // `a_b` would match `aXb`.
  it.each([
    ['%', '100% co-op', '100x co-op', '100%'],
    ['_', 'a_b night', 'aXb night', 'a_b'],
  ])('matches %s in q literally', async (_wildcard, literalName, lookalikeName, term) => {
    const token = newToken();
    const founder = await actors.user();
    const literal = await household(founder, `${token} ${literalName}`);
    await household(founder, `${token} ${lookalikeName}`);

    expect(idsOf(await listed(await actors.admin(), { q: `${token} ${term}` }))).toEqual([literal.id]);
  });

  describe('orders', () => {
    /**
     * Three households, created B, then A, then C, with 1, 3 and 2 members.
     * Their creation times are set a second apart, since the fixture can
     * write two within one millisecond.
     */
    const arrange = async () => {
      const token = newToken();
      const [founder, first, second] = [await actors.user(), await actors.user(), await actors.user()];
      const b = await household(founder, `${token} B`);
      const a = await household(founder, `${token} A`, [first, second]);
      const c = await household(founder, `${token} C`, [first]);

      const start = Date.now() - 60_000;
      for (const [index, { id }] of [b, a, c].entries()) {
        await db.client.household.update({ where: { id }, data: { createdAt: new Date(start + index * 1_000) } });
      }

      return { token, founder, a, b, c };
    };

    it.each([
      ['name', ['a', 'b', 'c']],
      ['newest', ['c', 'a', 'b']],
      ['members', ['a', 'c', 'b']],
    ] as const)('orders sort=%s', async (sort, expected) => {
      const fixture = await arrange();

      const page = await listed(await actors.admin(), { q: fixture.token, sort });

      expect(idsOf(page)).toEqual(expected.map((key) => fixture[key].id));
    });

    it('orders sort=deleted&status=all by most recently deleted, live households last', async () => {
      const { token, founder, a, b, c } = await arrange();
      const d = await household(founder, `${token} D`);
      await removeHousehold(founder, b.id);
      await removeHousehold(founder, d.id);
      // Deleted a second apart, D last, so the order is the deletion times'.
      const deletedAt = Date.now() - 10_000;
      await db.client.household.update({ where: { id: b.id }, data: { deletedAt: new Date(deletedAt) } });
      await db.client.household.update({ where: { id: d.id }, data: { deletedAt: new Date(deletedAt + 1_000) } });

      const ids = idsOf(await listed(await actors.admin(), { q: token, sort: 'deleted', status: 'all' }));

      expect(ids.slice(0, 2)).toEqual([d.id, b.id]);
      expect(ids.slice(2).sort()).toEqual([a.id, c.id].sort());
    });
  });

  it.each<[Record<string, string>, string]>([
    [{ sort: 'deleted' }, 'sort=deleted with status left out, which defaults to live'],
    [{ sort: 'deleted', status: 'live' }, 'sort=deleted with status live'],
    [{ q: 'a' }, 'a 1-character term'],
    [{ q: '   ' }, 'a term of spaces'],
    [{ q: 'a'.repeat(101) }, 'a term past the 100-character cap'],
    // Postgres refuses a null character in text: without the check this is a 500.
    [{ q: 'ab\u0000cd' }, 'a term with a null character'],
  ])('refuses %j with 400 (%s)', async (query) => {
    await list(await actors.admin(), query).expect(400);
  });
});
