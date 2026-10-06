import { ResourceType } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { apiCacheHas } from '../support/api-cache';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const API_KEY_HEADER = 'x-api-key';
const CREATE_KEY_PATH = '/api/auth/api-key/create';

/** A policy-checked read: `read` on `Notification`, which the owner's role grants. */
const UNREAD_PATH = '/api/notifications/unread';
const UNREAD_PERMISSION_SLUG = 'read:notification:own';

/** An authenticated route with no policy, and one the response cache serves. */
const ME_PATH = '/api/users/me';

interface MintedKey {
  readonly id: string;
  readonly headers: { readonly [API_KEY_HEADER]: string };
}

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

  const mintKey = async (owner: SessionActor): Promise<MintedKey> => {
    const response = await request(baseUrl)
      .post(CREATE_KEY_PATH)
      .set('Origin', baseUrl)
      .set(owner.headers)
      .send({ name: 'e2e' });

    if (response.status !== 200 || typeof response.body?.key !== 'string') {
      throw new Error(`minting a key failed: ${response.status} ${JSON.stringify(response.body)}`);
    }

    return { id: response.body.id, headers: { [API_KEY_HEADER]: response.body.key } };
  };

  const grantScope = async (key: MintedKey, slug: string, resourceType: ResourceType): Promise<void> => {
    const permission = await db.client.permission.findUniqueOrThrow({ where: { slug } });

    await db.client.apiKeyScope.create({
      data: { apiKeyId: key.id, permissionId: permission.id, resourceType },
    });
  };

  /** A key its owner minted, scoped to read notifications. */
  const scopedKey = async (owner: SessionActor): Promise<MintedKey> => {
    const key = await mintKey(owner);
    await grantScope(key, UNREAD_PERMISSION_SLUG, ResourceType.Notification);

    return key;
  };

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

  describe('the response cache', () => {
    it("keeps two owners' keys apart", async () => {
      const [alice, bob] = [await actors.user(), await actors.user()];
      const [aliceKey, bobKey] = [await mintKey(alice), await mintKey(bob)];

      const forAlice = await request(baseUrl).get(ME_PATH).set(aliceKey.headers).expect(200);
      const forBob = await request(baseUrl).get(ME_PATH).set(bobKey.headers).expect(200);

      expect(forAlice.body.user.id).toBe(alice.user.id);
      expect(forBob.body.user.id).toBe(bob.user.id);
      // Not vacuous: the first answer was cached, under its key's own entry.
      await expect(apiCacheHas(`apikey:${aliceKey.id}:en:${ME_PATH}`)).resolves.toBe(true);
    });

    it("keeps a key apart from its owner's session", async () => {
      const owner = await actors.user();
      const key = await mintKey(owner);

      const before = await request(baseUrl).get(ME_PATH).set(owner.headers).expect(200);
      await db.client.user.update({ where: { id: owner.user.id }, data: { firstName: 'Renamed' } });

      const viaKey = await request(baseUrl).get(ME_PATH).set(key.headers).expect(200);
      const viaSessionAgain = await request(baseUrl).get(ME_PATH).set(owner.headers).expect(200);

      // The key's request missed the session's entry and read the change...
      expect(viaKey.body.user.firstName).toBe('Renamed');
      // ...while the session's entry still holds the body from before it,
      // which is what shows the cache was in play at all.
      expect(viaSessionAgain.body).toEqual(before.body);
      expect(viaSessionAgain.body.user.firstName).not.toBe('Renamed');
    });
  });
});
