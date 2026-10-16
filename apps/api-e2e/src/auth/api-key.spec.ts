import { ResourceType } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { apiCacheHas, responseCacheKey } from '../support/api-cache';
import { API_KEY_HEADER, mintApiKey, type ApiKeyCaller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/** A policy-checked read: `read` on `Notification`, which the owner's role grants. */
const UNREAD_PATH = '/api/notifications/unread';
const UNREAD_PERMISSION_SLUG = 'read:notification:own';

/** An authenticated route with no policy. */
const ME_PATH = '/api/users/me';

/** A route that opts into the response cache (#530), and one any caller reaches. */
const LANGUAGES_PATH = '/api/languages';

/**
 * Requests that carry an API key (#529).
 *
 * better-auth's `AuthGuard` used to refuse every one of them with a 401: it
 * authenticates by calling `getSession`, and a key has no session, though
 * `HttpActorMiddleware` had already accepted the key. These run against the
 * whole stack, because the defect lived between the middleware and the guard,
 * where no unit test of either one could see it.
 *
 * Keys are minted through better-auth's own route, as their owner would mint
 * them. No route writes a key's scope rows yet (#266), and a key with none is
 * denied everywhere, so a key that should pass a policy gets one row arranged
 * directly. Generalizing this into a fixture is #270.
 */
describe('API key requests', () => {
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

  /** A key its owner minted, with no scope. */
  const mintKey = (owner: SessionActor): Promise<ApiKeyCaller> => mintApiKey(baseUrl, db.client, owner);

  /** A key its owner minted, scoped to read notifications. */
  const scopedKey = (owner: SessionActor): Promise<ApiKeyCaller> =>
    mintApiKey(baseUrl, db.client, owner, {
      slugs: [UNREAD_PERMISSION_SLUG],
      resourceType: ResourceType.Notification,
    });

  describe('authentication', () => {
    it('serves a policy-checked read to a key whose scope allows it', async () => {
      const key = await scopedKey(await actors.user());

      await request(baseUrl).get(UNREAD_PATH).set(key.headers).expect(200);
    });

    it('refuses the same read with a 403, not a 401, to a key with no scope rows', async () => {
      const key = await mintKey(await actors.user());

      await request(baseUrl).get(UNREAD_PATH).set(key.headers).expect(403);
    });

    it('refuses a key that was never minted with a 401', async () => {
      const response = await request(baseUrl).get(UNREAD_PATH).set(API_KEY_HEADER, 'not-a-real-key');

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ message: 'Invalid API key' });
    });

    // The body better-auth's guard sent, so a client matching on it still matches.
    it('still refuses a request with no credential at all with a 401', async () => {
      const response = await request(baseUrl).get(UNREAD_PATH);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
    });

    // better-auth's own default was 10 requests a day per key, and the 11th
    // was answered as an invalid key.
    it('serves more than ten requests from one key', async () => {
      const key = await scopedKey(await actors.user());

      for (let attempt = 1; attempt <= 12; attempt++) {
        const response = await request(baseUrl).get(UNREAD_PATH).set(key.headers);
        expect({ attempt, status: response.status }).toEqual({ attempt, status: 200 });
      }
    });

    it("answers /users/me with the key's owner", async () => {
      const owner = await actors.user();
      const key = await mintKey(owner);

      const response = await request(baseUrl).get(ME_PATH).set(key.headers).expect(200);

      expect(response.body.user).toMatchObject({ id: owner.user.id, email: owner.user.email });
    });
  });

  describe("the owner's ban", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('refuses a key whose owner is banned with a 403', async () => {
      const owner = await actors.user();
      const key = await scopedKey(owner);
      await request(baseUrl).get(UNREAD_PATH).set(key.headers).expect(200);

      await db.client.user.update({ where: { id: owner.user.id }, data: { banned: true } });
      const response = await request(baseUrl).get(UNREAD_PATH).set(key.headers);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ message: "This API key's owner is banned" });
    });

    it('refuses the key while the ban has yet to expire', async () => {
      const owner = await actors.user();
      const key = await scopedKey(owner);

      await db.client.user.update({
        where: { id: owner.user.id },
        data: { banned: true, banExpires: new Date(Date.now() + DAY_MS) },
      });

      await request(baseUrl).get(UNREAD_PATH).set(key.headers).expect(403);
    });

    it('serves the key again once the ban has expired', async () => {
      const owner = await actors.user();
      const key = await scopedKey(owner);

      await db.client.user.update({
        where: { id: owner.user.id },
        data: { banned: true, banExpires: new Date(Date.now() - DAY_MS) },
      });

      await request(baseUrl).get(UNREAD_PATH).set(key.headers).expect(200);
    });
  });

  /**
   * The languages body is the same for every caller, so `X-Cache` is what
   * shows whose entry a request was served from. A request that found another
   * caller's entry would report a HIT where these expect a MISS.
   */
  describe('the response cache', () => {
    const cacheStatus = async (headers: Record<string, string>) =>
      (await request(baseUrl).get(LANGUAGES_PATH).set(headers).expect(200)).headers['x-cache'];

    it("keeps two owners' keys apart", async () => {
      const [alice, bob] = [await actors.user(), await actors.user()];
      const [aliceKey, bobKey] = [await mintKey(alice), await mintKey(bob)];

      await expect(cacheStatus(aliceKey.headers)).resolves.toBe('MISS');
      await expect(cacheStatus(bobKey.headers)).resolves.toBe('MISS');

      // Not vacuous: each key's own entry was written, and serves its repeat.
      await expect(cacheStatus(bobKey.headers)).resolves.toBe('HIT');
      await expect(apiCacheHas(responseCacheKey(`apikey:${aliceKey.id}`, LANGUAGES_PATH))).resolves.toBe(true);
    });

    it("keeps a key apart from its owner's session", async () => {
      const owner = await actors.user();
      const key = await mintKey(owner);

      await expect(cacheStatus(owner.headers)).resolves.toBe('MISS');
      await expect(cacheStatus(key.headers)).resolves.toBe('MISS');

      await expect(cacheStatus(key.headers)).resolves.toBe('HIT');
      await expect(apiCacheHas(responseCacheKey(`apikey:${key.id}`, LANGUAGES_PATH))).resolves.toBe(true);
    });
  });
});
