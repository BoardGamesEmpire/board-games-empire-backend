import { Reach, ResourceType } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { listGamesEnvelope } from '../game/game-wire';
import { apiCacheHas, responseCacheKey } from '../support/api-cache';
import type { ApiKeyCaller, Caller } from '../support/api-key';
import { API_KEY_HEADER, mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

/** A policy-checked read: `read` on `Notification`, which the owner's role grants. */
const UNREAD_PATH = '/api/notifications/unread';
const UNREAD_PERMISSION_SLUG = 'read:notification:own';

/** A policy-checked read only staff hold: `read` on `AuditLog`. */
const AUDIT_LOGS_PATH = '/api/audit-logs';
const AUDIT_LOG_PERMISSION_SLUG = 'read:audit_log';

/** An authenticated route with no policy. */
const ME_PATH = '/api/users/me';

/** A route that opts into the response cache (#530), and one any caller reaches. */
const LANGUAGES_PATH = '/api/languages';

/** Games, whose read permissions carry conditions. */
const GAMES_PATH = '/api/games';

/**
 * Requests that carry an API key (#529).
 *
 * better-auth's `AuthGuard` used to refuse every one of them with a 401: it
 * authenticates by calling `getSession`, and a key has no session, though
 * `HttpActorMiddleware` had already accepted the key. These run against the
 * whole stack, because the defect lived between the middleware and the guard,
 * where no unit test of either one could see it.
 *
 * Keys are minted at `POST /api/api-keys`, as their owner would mint them,
 * with the key scopes the route writes (#1418); the conditioned case below
 * (`read:game:public`) mints through it too. A key with no key scope is denied
 * everywhere. Each key scope keeps its permission's conditions, rendered
 * where the key's owner holds the permission (#266). The routes themselves
 * are covered in `api-key-routes.spec.ts`. Generalizing this into a fixture
 * is #270.
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

    // The code and message better-auth's guard sent, so a client matching on
    // them still matches, inside the api's error envelope (#1260).
    it('still refuses a request with no credential at all with a 401', async () => {
      const response = await request(baseUrl).get(UNREAD_PATH);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
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

    // A key is judged by its own key scopes beside its owner's ability, so an
    // Admin's key does no more than it holds, though its owner can (#1418).
    // The route checks `read` on `AuditLog`, which Admin holds.
    it("refuses a privileged owner's key scoped to read:notification:own at the audit log, which a key scoped to read:audit_log reads (#1418)", async () => {
      const admin = await actors.admin();
      const notificationsKey = await scopedKey(admin);
      const auditKey = await mintApiKey(baseUrl, db.client, admin, {
        slugs: [AUDIT_LOG_PERMISSION_SLUG],
        resourceType: ResourceType.AuditLog,
      });

      await request(baseUrl).get(AUDIT_LOGS_PATH).set(admin.headers).expect(200);
      await request(baseUrl).get(AUDIT_LOGS_PATH).set(notificationsKey.headers).expect(403);
      await request(baseUrl).get(AUDIT_LOGS_PATH).set(auditKey.headers).expect(200);
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
   * A key scope keeps its permission's conditions, rendered where the key's
   * owner holds the permission (#266). Before, the key's own ability dropped
   * them, and only the owner's ability bounded the rows: a key scoped to
   * `read:game:public` read every game its owner could, Private ones
   * included.
   *
   * Each denial has its control in this describe: the owner's session reads
   * the same Private game, and a key scoped to `read:game` reads it too, so a
   * refusal is about the key's scope, not about the row or the route.
   */
  describe('key scopes keep their conditions (#266)', () => {
    const readGame = (caller: Caller, id: string) => request(baseUrl).get(`${GAMES_PATH}/${id}`).set(caller.headers);

    const listedGameIds = async (caller: Caller, who: string) =>
      listGamesEnvelope(
        await request(baseUrl).get(GAMES_PATH).set(caller.headers).expect(200),
        `GET ${GAMES_PATH} as ${who}`,
      ).games.map((game) => game.id);

    const arrangeGame = (createdById: string, reach: Reach) =>
      db.client.game.create({
        data: { title: `e2e game ${randomUUID().slice(0, 8)}`, reach, createdById },
        select: { id: true },
      });

    // The route answers 403, not 404, when the game exists and the caller may
    // not read it, as it does for another user's session.
    it("a key scoped to read:game:public reads a Public game and gets 403 on its owner's Private one, which the owner's session reads", async () => {
      const owner = await actors.user();
      const [publicGame, privateGame] = await Promise.all([
        arrangeGame(owner.user.id, Reach.Public),
        arrangeGame(owner.user.id, Reach.Private),
      ]);
      const key = await mintApiKey(baseUrl, db.client, owner, {
        slugs: ['read:game:public'],
        resourceType: ResourceType.Game,
      });

      await readGame(owner, privateGame.id).expect(200);
      expect((await listedGameIds(owner, 'the owner')).sort()).toEqual([publicGame.id, privateGame.id].sort());

      await readGame(key, publicGame.id).expect(200);
      await readGame(key, privateGame.id).expect(403);
      expect(await listedGameIds(key, 'the key')).toEqual([publicGame.id]);
    });

    it("a key scoped to read:game reads its owner's Private game", async () => {
      const owner = await actors.user();
      const privateGame = await arrangeGame(owner.user.id, Reach.Private);
      const key = await mintApiKey(baseUrl, db.client, owner, {
        slugs: ['read:game'],
        resourceType: ResourceType.Game,
      });

      await readGame(key, privateGame.id).expect(200);
      expect(await listedGameIds(key, 'the key')).toEqual([privateGame.id]);
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
