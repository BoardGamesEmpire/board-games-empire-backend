import { SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createEnvelope, listEnvelope, readEnvelope } from './household-wire';

/**
 * Every household read here follows a write to what it reads, and must
 * reflect it (#528).
 *
 * The api response-caches GETs by default, per caller, for `CACHE_TTL` (five
 * minutes unless configured, and nothing in this suite configures it). A household read served from that cache repeats the body it
 * returned BEFORE the write: the offline-first client re-reads after every
 * write to reconcile its local state, and the list route's own contract lets
 * it treat a household missing from a complete list as one it was removed
 * from — so a stale read is a wrong answer, not a slow one.
 *
 * The removal cases are worse than stale. `GET /households/:id` is guarded
 * type-level, and the row scoping that refuses a non-member lives in the
 * service — which a cache hit never reaches. So each case below reads FIRST,
 * priming whatever cache is in front of the route, and only then writes.
 * Without that first read every assertion here would pass with the cache
 * switched back on.
 */
describe('household reads after a write', () => {
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

  const readHousehold = (actor: SessionActor, id: string) =>
    request(baseUrl).get(`${HOUSEHOLDS_PATH}/${id}`).set(actor.headers);

  const membersPath = (householdId: string) => `${HOUSEHOLDS_PATH}/${householdId}/members`;

  const listedIds = async (actor: SessionActor, description: string) =>
    listEnvelope(await listHouseholds(actor).expect(200), description).households.map((household) => household.id);

  it('lists a household its caller has just created', async () => {
    const actor = await actors.user();

    await expect(listedIds(actor, 'GET /api/households before create')).resolves.toEqual([]);

    const created = createEnvelope(
      await request(baseUrl).post(HOUSEHOLDS_PATH).set(actor.headers).send({ name: 'Just founded' }).expect(201),
      'POST /api/households',
    );

    await expect(listedIds(actor, 'GET /api/households after create')).resolves.toEqual([created.household.id]);
  });

  it('reads back a rename its caller has just made', async () => {
    const owner = await actors.user();
    const fixture = await actors.householdWithMembers({ owner, name: 'Before the rename' });

    const before = readEnvelope(await readHousehold(owner, fixture.household.id).expect(200), 'GET before rename');
    expect(before.household.name).toBe('Before the rename');

    await request(baseUrl)
      .patch(`${HOUSEHOLDS_PATH}/${fixture.household.id}`)
      .set(owner.headers)
      .send({ name: 'After the rename' })
      .expect(200);

    const after = readEnvelope(await readHousehold(owner, fixture.household.id).expect(200), 'GET after rename');
    expect(after.household.name).toBe('After the rename');
  });

  it('refuses a removed member the household they could read a moment ago', async () => {
    // Actors first, roster before any of them issues an authenticated request:
    // the ability cache populates lazily per user (#272).
    const owner = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Removal pending',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const [membership] = fixture.members;

    await readHousehold(member, fixture.household.id).expect(200);

    await request(baseUrl)
      .delete(`${membersPath(fixture.household.id)}/${membership.member.id}`)
      .set(owner.headers)
      .expect(200);

    // 403, not 404: the household still exists, and this caller may no longer
    // see it — the same answer any non-member gets (household-authorization).
    await readHousehold(member, fixture.household.id).expect(403);
  });

  it('drops a household from the list of a member who has just left it', async () => {
    const owner = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'About to be left',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });

    await expect(listedIds(member, 'GET /api/households before leaving')).resolves.toEqual([fixture.household.id]);

    await request(baseUrl)
      .delete(`${membersPath(fixture.household.id)}/me`)
      .set(member.headers)
      .expect(200);

    await expect(listedIds(member, 'GET /api/households after leaving')).resolves.toEqual([]);
  });

  it('stops serving a member row its caller has just removed', async () => {
    // The member routes carry their own opt-out, so they get their own case:
    // everything above reads through the household controller.
    const owner = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Roster about to shrink',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const [membership] = fixture.members;
    const memberPath = `${membersPath(fixture.household.id)}/${membership.member.id}`;

    await request(baseUrl).get(memberPath).set(owner.headers).expect(200);

    await request(baseUrl).delete(memberPath).set(owner.headers).expect(200);

    await request(baseUrl).get(memberPath).set(owner.headers).expect(404);
  });
});
