import { AUTH_CLIENT_IP_HEADER, authFactory, createRedisAuthStorage, type RedisAuthStorage } from '@bge/auth';
import type { PrismaClient } from '@bge/database';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'iovalkey';
import { apiCacheKey } from '../support/api-cache';
import { REDIS_IMAGE } from '../support/e2e-env';

/**
 * better-auth's storage over a real Redis, doing in one step what better-auth
 * would otherwise do in two: counting a request against a rate limit (#832),
 * and using up a single-use verification value (#888). In-process rather than
 * over HTTP: the e2e api runs as `NODE_ENV=test`, so better-auth's limiter is
 * off there, and the harness runs one api process, where better-auth's own
 * lock already keeps a value single-use. Over a real Redis, because each step
 * is a Redis command, which an in-memory store can't stand in for. Each
 * instance here is one api process, so two instances over two clients are two
 * processes sharing one Redis. Like `bootstrap/cache-flush.spec.ts`, this spec
 * starts its own container.
 */

/** The configuration an instance needs to build, with email and password sign-in on. */
const config = new ConfigService({
  auth: {
    url: 'http://localhost:33333',
    secret: 'an-e2e-test-secret-of-at-least-32-characters',
    trustedOrigins: [],
    useEmailPasswordAuth: true,
  },
});

/** A database where every lookup finds nothing. */
const noUsers = new Proxy(
  {},
  { get: () => new Proxy({}, { get: (_model, operation) => async () => (operation === 'findMany' ? [] : null) }) },
) as PrismaClient;

/**
 * An instance over `client`, or over `storage` when given, with the limiter
 * on. better-auth turns it on only when NODE_ENV is production, which it reads
 * once, at import. The instance reads the setting from its context on every
 * request, so it is switched on there.
 */
async function limitedAuth(client: Redis, storage: RedisAuthStorage = createRedisAuthStorage(client)) {
  const auth = authFactory(noUsers, config, storage);
  (await auth.$context).rateLimit.enabled = true;
  return auth;
}

/**
 * A wrong password against a database with no users, which better-auth
 * answers with 401 after hashing the password, as it would for a registered
 * user's wrong one.
 */
async function signIn(auth: ReturnType<typeof authFactory>, clientIp: string): Promise<number> {
  const response = await auth.handler(
    new Request('http://localhost:33333/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CLIENT_IP_HEADER]: clientIp },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'not-the-password' }),
    }),
  );

  return response.status;
}

describe("better-auth's storage over Redis", () => {
  let container: StartedRedisContainer;
  let redisA: Redis;
  let redisB: Redis;

  beforeAll(async () => {
    container = await new RedisContainer(REDIS_IMAGE).start();
    redisA = new Redis(container.getConnectionUrl());
    redisB = new Redis(container.getConnectionUrl());
  }, 120_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await Promise.all([redisA.quit(), redisB.quit()]);
    await container.stop();
  });

  describe('rate-limit counts', () => {
    it('refuse every parallel sign-in past the third, each counted through increment (#832)', async () => {
      // Each request counted through increment means better-auth took its
      // atomic path, not its best-effort read and then write. Its warning
      // about that fallback is once per process, so it would only prove this
      // in whichever test signed in first.
      const storage = createRedisAuthStorage(redisA);
      const increment = jest.spyOn(storage, 'increment');
      const get = jest.spyOn(storage, 'get');
      const auth = await limitedAuth(redisA, storage);

      const statuses = await Promise.all(Array.from({ length: 6 }, () => signIn(auth, '198.51.100.20')));

      expect(statuses.sort()).toEqual([401, 401, 401, 429, 429, 429]);
      expect(increment).toHaveBeenCalledTimes(6);
      expect(get).not.toHaveBeenCalled();
    });

    it('count a burst split across two api processes as one (#832)', async () => {
      const [one, two] = [await limitedAuth(redisA), await limitedAuth(redisB)];

      const statuses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => signIn(i % 2 ? two : one, '198.51.100.21')),
      );

      expect(statuses.sort()).toEqual([401, 401, 401, 429, 429, 429]);
    });

    it("expire no later than the window, which a later request doesn't extend (#832)", async () => {
      // A count with no expiry would lock its client out until Redis restarted.
      // One whose expiry each request pushed out would keep a client that
      // keeps trying locked out, rather than letting it back in ten seconds
      // after its first attempt.
      const storage = createRedisAuthStorage(redisA);
      const key = apiCacheKey('auth_window-probe');

      await storage.increment('window-probe', 10);
      const first = await redisA.pttl(key);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await storage.increment('window-probe', 10);
      const second = await redisA.pttl(key);

      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(10_000);
      expect(first - second).toBeGreaterThanOrEqual(50);
    });
  });

  describe('verification values', () => {
    it('go to exactly one of two api processes using one at once (#888)', async () => {
      const [one, two] = [createRedisAuthStorage(redisA), createRedisAuthStorage(redisB)];
      await one.set('verification:race', 'payload', 60);

      const taken = await Promise.all([one.getAndDelete('verification:race'), two.getAndDelete('verification:race')]);

      expect(taken.filter((value) => value === 'payload')).toHaveLength(1);
      expect(taken.filter((value) => value === undefined)).toHaveLength(1);
    });

    it('are used once by better-auth, through getAndDelete, with no warning (#888)', async () => {
      // better-auth warns once per instance, the first time it falls back to
      // a read and then a delete, so the instance is this test's own.
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const ctx = await authFactory(noUsers, config, createRedisAuthStorage(redisA)).$context;
      await ctx.internalAdapter.createVerificationValue({
        identifier: 'e2e-single-use',
        value: 'u1',
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(ctx.internalAdapter.consumeVerificationValue('e2e-single-use')).resolves.toMatchObject({
        value: 'u1',
      });
      await expect(ctx.internalAdapter.consumeVerificationValue('e2e-single-use')).resolves.toBeNull();
      expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringMatching(/getAndDelete/) }));
    });
  });
});
