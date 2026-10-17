import { QuotaScope, ResourceType, SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { quotasEnvelope } from './quota-wire';

/**
 * Which quotas each list answers with, over the real routes (#515).
 *
 * `GET /api/quotas` used to take the actor's ceiling as its whole answer, so
 * one list mixed the server's quotas with every household the actor
 * administers. It now lists only the quotas that belong to no household:
 * server and user quotas and the default quotas. A household's own and
 * per-member quotas moved to `GET /api/households/:householdId/quotas`, which
 * its owners and admins, staff and the Owner may read.
 *
 * The rows are arranged directly: setting a quota is not what is under test,
 * and no route writes a server or user quota for a household admin to see.
 */
describe('quota read scope', () => {
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

  const listServerQuotas = (actor: SessionActor) => request(baseUrl).get('/api/quotas').set(actor.headers);

  const listHouseholdQuotas = (caller: Caller, householdId: string) =>
    request(baseUrl).get(`/api/households/${householdId}/quotas`).set(caller.headers);

  const idsOf = (rows: readonly { id: string }[]) => rows.map((row) => row.id).sort();

  /**
   * A household with an owner and a plain member, a second household with an
   * admin of its own, and a quota of every kind: the server's, a user's, a
   * default, each household's own, and one per-member quota.
   */
  const arrange = async () => {
    const [admin, householdOwner, householdMember, otherOwner, otherAdmin, plainUser] = await Promise.all([
      actors.admin(),
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
    ]);

    const [{ household, members }, { household: otherHousehold }] = await Promise.all([
      actors.householdWithMembers({
        owner: householdOwner,
        members: [{ actor: householdMember, role: SystemRole.HouseholdMember }],
      }),
      actors.householdWithMembers({
        owner: otherOwner,
        members: [{ actor: otherAdmin, role: SystemRole.HouseholdAdmin }],
      }),
    ]);

    const quota = (scope: QuotaScope, scopeId: string, householdId: string | null, resource: string) =>
      db.client.quota.create({ data: { scope, scopeId, householdId, resource, limit: 8n }, select: { id: true } });

    const [server, user, memberDefault, own, perMember, others] = await Promise.all([
      quota(QuotaScope.Server, '*', null, 'storage_bytes'),
      quota(QuotaScope.User, plainUser.user.id, null, 'storage_bytes'),
      quota(QuotaScope.HouseholdMember, '*', null, 'storage_bytes'),
      quota(QuotaScope.Household, household.id, household.id, 'household_member_count'),
      quota(QuotaScope.HouseholdMember, members[0].member.id, household.id, 'storage_bytes'),
      quota(QuotaScope.Household, otherHousehold.id, otherHousehold.id, 'household_member_count'),
    ]);

    return {
      actors: { admin, householdOwner, householdMember, otherAdmin, plainUser },
      household,
      rows: {
        unattached: idsOf([server, user, memberDefault]),
        household: idsOf([own, perMember]),
        otherHousehold: others.id,
      },
    };
  };

  it("lists a household's owner its household's quotas on the household's route, and none on the server's", async () => {
    const { actors: who, household, rows } = await arrange();

    const own = quotasEnvelope(
      await listHouseholdQuotas(who.householdOwner, household.id).expect(200),
      'GET /api/households/:householdId/quotas as its owner',
    );
    expect(idsOf(own)).toEqual(rows.household);

    // Their only quota permission is on their household's rows, and none of
    // those belongs to no household.
    const server = quotasEnvelope(
      await listServerQuotas(who.householdOwner).expect(200),
      'GET /api/quotas as a household owner',
    );
    expect(server).toEqual([]);
  });

  // The member holds no quota permission at all and is refused at the route's
  // type gate. The other household's admin passes that gate on their own
  // household's permission, so it is the instance check that refuses them.
  // Without it they would get an empty list where the member gets 403.
  it("refuses a plain member, and an admin of another household, the household's quotas", async () => {
    const { actors: who, household } = await arrange();

    await listHouseholdQuotas(who.householdMember, household.id).expect(403);
    await listHouseholdQuotas(who.otherAdmin, household.id).expect(403);
  });

  it("lists Admin a household's quotas on its route, and only the unattached quotas on the server's", async () => {
    const { actors: who, household, rows } = await arrange();

    // The control: Admin reads the server list where the base role is
    // refused it, so the rows below come from Admin's `read:quota` and not
    // from the list being open to everyone.
    await listServerQuotas(who.plainUser).expect(403);

    const server = quotasEnvelope(await listServerQuotas(who.admin).expect(200), 'GET /api/quotas as Admin');
    expect(idsOf(server)).toEqual(rows.unattached);

    // Admin's ceiling admits every quota, the other household's included, so
    // the household's route is what narrows it to the one household.
    const own = quotasEnvelope(
      await listHouseholdQuotas(who.admin, household.id).expect(200),
      'GET /api/households/:householdId/quotas as Admin',
    );
    expect(idsOf(own)).toEqual(rows.household);
    expect(idsOf(own)).not.toContain(rows.otherHousehold);
  });

  // The route's liveness guard answers only an actor every one of whose
  // abilities reads households, which a key scoped to quotas alone is not, and
  // a soft delete leaves the household's quota rows in place. So the service
  // checks liveness itself, after the instance check, as the invite list does.
  it("answers 404 to a key scoped to quotas alone, for a deleted household's quotas", async () => {
    const { actors: who, household, rows } = await arrange();
    const key = await mintApiKey(baseUrl, db.client, who.admin, {
      slugs: ['read:quota'],
      resourceType: ResourceType.Quota,
    });

    // The control: the key reads the household's quotas while it is live.
    const live = quotasEnvelope(
      await listHouseholdQuotas(key, household.id).expect(200),
      'GET /api/households/:householdId/quotas with a quota-scoped key',
    );
    expect(idsOf(live)).toEqual(rows.household);

    await db.client.household.update({ where: { id: household.id }, data: { deletedAt: new Date() } });

    await listHouseholdQuotas(key, household.id).expect(404);
  });
});
