import { PluginCategory, PluginGrantStatus, PluginScope, RiskLevel, type Plugin } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { MANAGE_DIGEST_CHECK, type Check } from './manifest-checks';
import { householdPluginKey } from './plugin-api-key';

/**
 * The household plugin routes answer 404 for a household that is missing or
 * soft-deleted, as every other route under `/households/:householdId` does
 * (#553, #299).
 *
 * Before the household liveness guard ran here, the answer depended on who
 * asked. Staff read every type, and the three reads never checked that the
 * household exists, so an admin or a moderator got 200 for a household that was
 * never there and saw a deleted one's plugins. A household role got 403, since
 * a deleted household drops out of its members' ability graphs.
 *
 * A real plugin is installed for every case, so no answer here can be the
 * plugin's own 404 standing in for the household's.
 *
 * The 404 is no new way to learn which households exist. The guard answers it
 * only to an actor that `GET /households/:id` already answered 404 for a missing
 * household and 403 for a hidden live one; anyone else keeps the 403 whatever
 * the id. The cases for actors with no role in the household pin both halves.
 */
describe('household plugin routes for a missing or deleted household (#553)', () => {
  const baseUrl = requireBaseUrl(process.env);

  /** An allowlisted public read, which a household-scope consent may hold (#591). */
  const HOUSEHOLD_CHECK: Check = {
    slug: 'read:game:public',
    required: false,
    reason: { en: 'Lists the public games the household digest features.' },
    consentScope: 'household',
  };

  let db: TestDatabase;
  let actors: Actors;
  let plugin: Plugin;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  beforeEach(async () => {
    const manifest = buildPluginManifest({
      scope: 'household',
      bgeCompat: '>=0.0.0',
      permissions: { checks: [MANAGE_DIGEST_CHECK, HOUSEHOLD_CHECK] },
    });

    plugin = await db.client.plugin.create({
      data: {
        slug: manifest.slug,
        version: manifest.version,
        category: PluginCategory.FeedbackSink,
        scope: PluginScope.Household,
        manifestJson: manifest as never,
        enabled: true,
        bundled: false,
        installedSha256: randomUUID(),
      },
    });
    await db.client.pluginPermission.create({
      data: { pluginId: plugin.id, slug: `plugin|${plugin.slug}|manage:digest`, riskLevel: RiskLevel.Low },
    });
  });

  afterAll(async () => {
    await db.close();
  });

  const base = (householdId: string) => `/api/households/${householdId}/plugins`;

  const READS: readonly { readonly name: string; readonly send: (actor: Caller, id: string) => request.Test }[] = [
    { name: 'GET plugins', send: (actor, id) => request(baseUrl).get(base(id)).set(actor.headers) },
    {
      name: 'GET consent',
      send: (actor, id) =>
        request(baseUrl)
          .get(`${base(id)}/${plugin.slug}/consent`)
          .set(actor.headers),
    },
    {
      name: 'GET features',
      send: (actor, id) =>
        request(baseUrl)
          .get(`${base(id)}/${plugin.slug}/features`)
          .set(actor.headers),
    },
  ];

  const WRITES: readonly { readonly name: string; readonly send: (actor: Caller, id: string) => request.Test }[] = [
    {
      name: 'POST grants',
      send: (actor, id) =>
        request(baseUrl)
          .post(`${base(id)}/${plugin.slug}/grants`)
          .set(actor.headers)
          .send({ permissionSlug: HOUSEHOLD_CHECK.slug, status: PluginGrantStatus.Granted }),
    },
    {
      name: 'POST enable',
      send: (actor, id) =>
        request(baseUrl)
          .post(`${base(id)}/${plugin.slug}/enable`)
          .set(actor.headers)
          .send({}),
    },
    {
      name: 'POST disable',
      send: (actor, id) =>
        request(baseUrl)
          .post(`${base(id)}/${plugin.slug}/disable`)
          .set(actor.headers)
          .send({}),
    },
    {
      name: 'PATCH config',
      send: (actor, id) =>
        request(baseUrl)
          .patch(`${base(id)}/${plugin.slug}/config`)
          .set(actor.headers)
          .send({ config: {} }),
    },
  ];

  const STAFF: readonly { readonly kind: string; readonly make: () => Promise<SessionActor> }[] = [
    { kind: 'an admin', make: () => actors.admin() },
    { kind: 'a moderator', make: () => actors.moderator() },
  ];

  /** A household its owner has soft-deleted through the API, as a real delete does it. */
  const deletedHousehold = async (): Promise<{ readonly householdId: string; readonly owner: SessionActor }> => {
    const owner = await actors.user();
    const { household } = await actors.householdWithMembers({ owner, name: 'Deleted with its plugins' });

    await request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers).expect(200);

    return { householdId: household.id, owner };
  };

  /** Each response, by route, so a failure names every route that answered wrong. */
  const statuses = async (
    routes: typeof READS,
    actor: Caller,
    householdId: string,
  ): Promise<Record<string, number>> => {
    const answered: Record<string, number> = {};

    for (const route of routes) {
      answered[route.name] = (await route.send(actor, householdId)).status;
    }

    return answered;
  };

  const every = (routes: typeof READS, status: number) =>
    Object.fromEntries(routes.map((route) => [route.name, status]));
  const all404 = (routes: typeof READS) => every(routes, 404);
  const all403 = (routes: typeof READS) => every(routes, 403);

  /** A household its owner keeps, which the actor under test has no role in. */
  const someoneElsesHousehold = async (): Promise<string> => {
    const { household } = await actors.householdWithMembers({ owner: await actors.user(), name: 'Live, not theirs' });

    return household.id;
  };

  describe.each(STAFF)('staff: $kind', ({ make }) => {
    it('answers 404 on the reads for a household that never existed, where it answered 200', async () => {
      const staff = await make();

      await expect(statuses(READS, staff, `missing-${randomUUID()}`)).resolves.toEqual(all404(READS));
    });

    it('answers 404 on the reads for a soft-deleted household, rather than listing its plugins', async () => {
      const staff = await make();
      const { householdId } = await deletedHousehold();

      await expect(statuses(READS, staff, householdId)).resolves.toEqual(all404(READS));
    });

    it('still reads a live household', async () => {
      // Answers for a live household do not change.
      const staff = await make();
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner, name: 'Live, read by staff' });

      await READS[0].send(staff, household.id).expect(200);
    });
  });

  describe('a household role', () => {
    it("answers 404 to a deleted household's owner on all seven routes, where it answered 403", async () => {
      const { householdId, owner } = await deletedHousehold();
      const routes = [...READS, ...WRITES];

      await expect(statuses(routes, owner, householdId)).resolves.toEqual(all404(routes));
    });

    it("still reaches a live household's plugins", async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner, name: 'Live, read by its owner' });

      await READS[0].send(owner, household.id).expect(200);
    });
  });

  describe('a user with no role in the household', () => {
    // A user session reads Household, so the guard answers it as the
    // household routes do: 404 for a missing id, 403 for a hidden live one.
    it('answers 404 on all seven routes for a household that never existed, where it answered 403', async () => {
      const user = await actors.user();
      const routes = [...READS, ...WRITES];

      await expect(statuses(routes, user, `missing-${randomUUID()}`)).resolves.toEqual(all404(routes));
    });

    it('still answers 403 on all seven routes for a live household it cannot see', async () => {
      const user = await actors.user();
      const routes = [...READS, ...WRITES];

      await expect(statuses(routes, user, await someoneElsesHousehold())).resolves.toEqual(all403(routes));
    });
  });

  /**
   * An actor the guard passes through untouched: a key scoped to the plugin
   * routes holds no read on Household, so it was never told which households
   * exist and must not be told here. Its answer is 403 whatever the household's
   * state.
   */
  describe('an API key with no household read', () => {
    const pluginKey = (owner: SessionActor) => householdPluginKey(baseUrl, db.client, owner);

    it("reads its owner's own household, so the refusals below are not a key that works nowhere", async () => {
      const owner = await actors.user();
      const { household } = await actors.householdWithMembers({ owner, name: 'Live, read through a key' });

      await READS[0].send(await pluginKey(owner), household.id).expect(200);
    });

    it('answers 403 on all seven routes, whether the household is missing, deleted or live', async () => {
      const owner = await actors.user();
      await actors.householdWithMembers({ owner, name: 'Owned by the key owner' });
      const key = await pluginKey(owner);
      const routes = [...READS, ...WRITES];

      const answered = {
        missing: await statuses(routes, key, `missing-${randomUUID()}`),
        deleted: await statuses(routes, key, (await deletedHousehold()).householdId),
        live: await statuses(routes, key, await someoneElsesHousehold()),
      };

      expect(answered).toEqual({ missing: all403(routes), deleted: all403(routes), live: all403(routes) });
    });

    /**
     * Its owner was the household's admin, and the key was let in before the
     * delete. Once the delete lands, the owner's graph drops the household and
     * the key is refused 403 like any other. A write that loses the race to the
     * delete must answer the same (`plugin-household-tombstone.spec.ts`).
     */
    it("answers 403 on all seven routes for its owner's own household once it is deleted", async () => {
      const owner = await actors.user();
      // Kept, so the key still holds plugin rules and the 403 is the deleted household's.
      await actors.householdWithMembers({ owner, name: 'Kept by the key owner' });
      const { household } = await actors.householdWithMembers({ owner, name: 'Deleted by the key owner' });
      const key = await pluginKey(owner);
      const routes = [...READS, ...WRITES];

      await request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers).expect(200);

      await expect(statuses(routes, key, household.id)).resolves.toEqual(all403(routes));
    });
  });
});
