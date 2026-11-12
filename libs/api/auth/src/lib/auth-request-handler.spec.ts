import type { PrismaClient } from '@bge/database';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import Keyv from 'keyv';
import { authFactory } from './auth-factory';
import { createAuthRequestHandler } from './auth-request-handler';
import { AUTH_CLIENT_IP_HEADER } from './constants';
import { memoryAuthStorage } from './memory-auth-storage.fixture';
import { noteStorageFailure } from './storage-failure-record';

/** The configuration an instance needs to build, with email and password sign-in on. */
const config = new ConfigService({
  auth: {
    url: 'http://localhost:33333',
    secret: 'a-unit-test-secret-of-at-least-32-characters',
    trustedOrigins: [],
    useEmailPasswordAuth: true,
  },
});

/** Every lookup finds nothing. */
const noUsers = prismaWith({});

/** The address every request here comes from, which better-auth keys its rate-limit counts on. */
const CLIENT_IP = '198.51.100.4';

type ModelFake = Record<string, (...args: unknown[]) => Promise<unknown>>;

/** A Prisma client whose `models` answer as given; every other lookup finds nothing. */
function prismaWith(models: Record<string, ModelFake>): PrismaClient {
  return new Proxy(
    {},
    {
      get: (_client, model) =>
        new Proxy(
          {},
          {
            get: (_model, operation) =>
              models[model as string]?.[operation as string] ?? (async () => (operation === 'findMany' ? [] : null)),
          },
        ),
    },
  ) as PrismaClient;
}

/** Takes the user-created event a sign-up emits, and does nothing with it. */
const noEvents = { emit: () => true } as unknown as EventEmitter2;

/** A store whose connection drops on every read, as Redis's does when it goes away. */
class ReadsFail extends Map<string, unknown> {
  override get(): unknown {
    throw new Error('Connection is closed.');
  }
}

/**
 * A store whose connection drops for one kind of call on the keys `fails`
 * picks, as Redis's can between two commands. The failure is raised beneath
 * the api's storage, as a Redis failure is, so the storage notes it (#894).
 * `failures` lists every key that failed, so a test can show it reached the
 * storage.
 */
function storeFailing(method: 'get' | 'set' | 'delete', fails: (key: string) => boolean) {
  const failures: string[] = [];
  const entries = new Map<string, unknown>();
  const original = entries[method].bind(entries) as (key: string, ...rest: unknown[]) => unknown;
  jest.spyOn(entries, method).mockImplementation(((key: string, ...rest: unknown[]) => {
    if (fails(key)) {
      failures.push(key);
      throw new Error('Connection is closed.');
    }

    return original(key, ...rest);
  }) as never);

  return { store: new Keyv({ store: entries, throwOnErrors: true }), failures };
}

/** Whether `key` is one of better-auth's rate-limit counts, which it keys on the client's address. */
const isCount = (key: string) => key.includes(CLIENT_IP);

/**
 * The api's handler for `/api/auth/*` over a real instance, with better-auth's
 * limiter on. better-auth turns it on only when NODE_ENV is production, which
 * it reads once, at import, so it is switched on in the instance's context.
 * Messages render as their catalog keys.
 */
async function servedOver(store: Keyv, prisma: PrismaClient = noUsers) {
  store.on('error', () => undefined);
  const auth = authFactory(prisma, config, memoryAuthStorage(store), noEvents);
  (await auth.$context).rateLimit.enabled = true;

  return createAuthRequestHandler(auth.handler, { render: (key) => key });
}

const signIn = (handle: (request: Request) => Promise<Response>) =>
  handle(
    new Request('http://localhost:33333/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CLIENT_IP_HEADER]: CLIENT_IP },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'not-the-password' }),
    }),
  );

/**
 * better-auth answers two failures without the stable code and plain-language
 * message every other refusal carries: its rate limiter's 429, and a request
 * it cannot answer at all because the store is unreachable. Both became
 * reachable once its store kept counts and raised failures (#640).
 */
describe('createAuthRequestHandler', () => {
  it("gives better-auth's 429 a code and a plain-language message, and keeps its retry hint (#640)", async () => {
    const handle = await servedOver(new Keyv({ throwOnErrors: true }));
    for (let attempt = 0; attempt < 3; attempt++) {
      await signIn(handle);
    }

    const refused = await signIn(handle);

    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'RATE_LIMITED',
      message: 'errors.auth.rate_limited',
    });
    expect(refused.headers.get('content-type')).toMatch(/^application\/json/);
    expect(Number(refused.headers.get('x-retry-after'))).toBeGreaterThan(0);
  });

  it('answers 503 with a code when the store cannot be read, where better-auth would throw (#640)', async () => {
    // The limiter reads its count ahead of better-auth's own error handling,
    // so the handler throws, and Express would answer a bare 500.
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const handle = await servedOver(new Keyv({ store: new ReadsFail(), throwOnErrors: true }));

    const response = await signIn(handle);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'AUTH_UNAVAILABLE',
      message: 'errors.auth.unavailable',
    });
    expect(logged).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Connection is closed.'));
    logged.mockRestore();
  });

  it('passes every other answer through as better-auth gave it, its own code included (#640)', async () => {
    const handle = await servedOver(new Keyv({ throwOnErrors: true }));

    const response = await signIn(handle);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  });

  it.each([
    ['a body that is not JSON', 'Too many requests'],
    ['a JSON body with no code', JSON.stringify({ message: 'Too many requests' })],
  ])('gives a 429 with %s the code too (#640)', async (_, body) => {
    const handle = createAuthRequestHandler(async () => new Response(body, { status: 429 }), {
      render: (key) => key,
    });

    const refused = await handle(new Request('http://localhost:33333/api/auth/sign-in/email'));

    await expect(refused.json()).resolves.toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'RATE_LIMITED',
      message: 'errors.auth.rate_limited',
    });
  });

  it('leaves a 429 that already carries a code as it is (#640)', async () => {
    const coded = { code: 'TOO_MANY_ATTEMPTS', message: 'Wait a minute' };
    const handle = createAuthRequestHandler(async () => Response.json(coded, { status: 429 }), {
      render: (key) => key,
    });

    const refused = await handle(new Request('http://localhost:33333/api/auth/sign-in/email'));

    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual(coded);
  });

  /**
   * better-auth catches what an endpoint throws, and answers anything that
   * isn't its own error with an empty 500; some storage failures it catches
   * itself and answers a coded 500 of its own, without the error. Each
   * request records whether a storage call failed, so a storage failure
   * answers 503 and anything else a coded 500 (#894).
   */
  describe('a failure inside an endpoint (#894)', () => {
    let loggedErrors: jest.SpyInstance;
    beforeEach(() => {
      loggedErrors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    // Our own answers, in the api's error envelope (#1260).
    const unavailable = {
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'AUTH_UNAVAILABLE',
      message: 'errors.auth.unavailable',
    };
    const failed = {
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'AUTH_FAILED',
      message: 'errors.auth.failed',
    };

    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      new Request(`http://localhost:33333/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTH_CLIENT_IP_HEADER]: CLIENT_IP, ...headers },
        body: JSON.stringify(body),
      });

    /** The system settings row, with sign-up and password resets on, so the setting gates let the request through. */
    const settingsOn: ModelFake = {
      findUnique: async () => ({ allowUserRegistration: true, allowPasswordResets: true, allowUsernameChange: true }),
    };

    const aUser = {
      id: 'user-1',
      email: 'reset@example.com',
      emailVerified: true,
      name: 'reset',
      username: 'reset',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
    };

    it('answers a password reset whose single-use value cannot be taken 503 with a code, where better-auth answered an empty 500 (#894)', async () => {
      // The count succeeds; the reset link's value reads, then fails as it is
      // taken.
      const { store, failures } = storeFailing('delete', (key) => key.includes('verification:'));
      const storage = memoryAuthStorage(store);
      const takes = jest.spyOn(storage, 'getAndDelete');
      await storage.set(
        'verification:reset-password:any-token',
        JSON.stringify({
          id: 'verification-1',
          identifier: 'reset-password:any-token',
          value: aUser.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
        3_600,
      );
      const prisma = prismaWith({
        systemSetting: settingsOn,
        user: { findFirst: async () => aUser, findUnique: async () => aUser },
      });
      const auth = authFactory(prisma, config, storage);
      (await auth.$context).rateLimit.enabled = true;
      const handle = createAuthRequestHandler(auth.handler, { render: (key) => key });

      const response = await handle(
        post('/reset-password', { token: 'any-token', newPassword: 'a-new-password-1234' }),
      );

      expect(takes).toHaveBeenCalled();
      expect(failures).not.toHaveLength(0);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual(unavailable);
    });

    it('answers a sign-in whose session cannot be written 503 with a code (#894)', async () => {
      const { store, failures } = storeFailing('set', (key) => !isCount(key));
      const prisma = prismaWith({
        systemSetting: settingsOn,
        user: { create: async (args) => ({ id: 'anonymous-1', ...(args as { data: object }).data }) },
      });
      const handle = await servedOver(store, prisma);

      const response = await handle(post('/sign-in/anonymous', {}));

      expect(failures).not.toHaveLength(0);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual(unavailable);
    });

    it('answers a session read the storage fails 503, where better-auth answers its own 500 (#894)', async () => {
      const { store, failures } = storeFailing('get', (key) => !isCount(key));
      const handle = await servedOver(store);

      const response = await handle(
        new Request('http://localhost:33333/api/auth/get-session', {
          headers: { authorization: 'Bearer some-token', [AUTH_CLIENT_IP_HEADER]: CLIENT_IP },
        }),
      );

      expect(failures).not.toHaveLength(0);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual(unavailable);
    });

    it('answers a route that requires a session 503 when the storage fails its read, where better-auth answers 401 (#894)', async () => {
      // better-auth swallows the failed read and finds no session, so a
      // signed-in user would read as signed out (docs/REDIS.md).
      const { store, failures } = storeFailing('get', (key) => !isCount(key));
      const handle = await servedOver(store);

      const response = await handle(
        new Request('http://localhost:33333/api/auth/list-sessions', {
          headers: { authorization: 'Bearer some-token', [AUTH_CLIENT_IP_HEADER]: CLIENT_IP },
        }),
      );

      expect(failures).not.toHaveLength(0);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual(unavailable);
    });

    it("logs better-auth's own 500 on a request with its cause, which its answer leaves out (#894)", async () => {
      const { store, failures } = storeFailing('get', (key) => !isCount(key));
      const handle = await servedOver(store);

      await handle(
        new Request('http://localhost:33333/api/auth/get-session', {
          headers: { authorization: 'Bearer some-token', [AUTH_CLIENT_IP_HEADER]: CLIENT_IP },
        }),
      );

      expect(failures).not.toHaveLength(0);
      expect(loggedErrors).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'INTERNAL_SERVER_ERROR',
          err: expect.objectContaining({
            name: 'APIError',
            statusCode: 500,
            cause: expect.objectContaining({ message: 'Connection is closed.' }),
          }),
        }),
      );
    });

    it("doesn't log better-auth's 500 on a direct call, whose caller gets the error itself (#894)", async () => {
      const { store } = storeFailing('get', () => true);
      store.on('error', () => undefined);
      const auth = authFactory(noUsers, config, memoryAuthStorage(store), noEvents);

      await expect(
        auth.api.getSession({ headers: new Headers({ authorization: 'Bearer some-token' }) }),
      ).rejects.toMatchObject({ statusCode: 500 });

      expect(loggedErrors).not.toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.objectContaining({ name: 'APIError' }) }),
      );
    });

    it('answers a failure that is not the storage 500 AUTH_FAILED with a message, where better-auth answered an empty 500 (#894)', async () => {
      const fault = jest.fn(async () => {
        throw new Error('a fault');
      });
      const handle = await servedOver(
        new Keyv({ throwOnErrors: true }),
        prismaWith({ user: { findFirst: fault, findUnique: fault } }),
      );

      const response = await signIn(handle);

      expect(fault).toHaveBeenCalled();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual(failed);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(loggedErrors).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('a fault'));
    });

    const anyRequest = () => new Request('http://localhost:33333/api/auth/sign-in/email', { method: 'POST' });
    const betterAuths500 = () =>
      Response.json({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' }, { status: 500 });

    it('answers a throw with no storage failure 500 AUTH_FAILED (#894)', async () => {
      const handle = createAuthRequestHandler(
        async () => {
          throw new Error('a fault');
        },
        { render: (key) => key },
      );

      const response = await handle(anyRequest());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual(failed);
    });

    it('answers an empty 500 with no storage failure 500 AUTH_FAILED (#894)', async () => {
      const handle = createAuthRequestHandler(async () => new Response(null, { status: 500 }), {
        render: (key) => key,
      });

      const response = await handle(anyRequest());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual(failed);
    });

    it.each([
      ['a JSON body with no code', JSON.stringify({ message: 'Dynamic baseURL could not be resolved' })],
      ['a body that is not JSON', 'Internal Server Error'],
    ])('answers a 500 with %s and no storage failure 500 AUTH_FAILED (#894)', async (_, body) => {
      // better-auth answers a 500 of its own with only a message, in English,
      // when an internal error of its own reaches an endpoint.
      const handle = createAuthRequestHandler(async () => new Response(body, { status: 500 }), {
        render: (key) => key,
      });

      const response = await handle(anyRequest());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual(failed);
    });

    it("keeps better-auth's headers, its cookies among them, on the 500 it answers AUTH_FAILED (#894)", async () => {
      const handle = createAuthRequestHandler(
        async () => {
          const headers = new Headers({ 'x-kept': 'yes', 'content-length': '21' });
          headers.append('set-cookie', 'bge.session_token=; Max-Age=0; Path=/');
          return new Response('Internal Server Error', { status: 500, headers });
        },
        { render: (key) => key },
      );

      const response = await handle(anyRequest());

      expect(response.status).toBe(500);
      expect(response.headers.get('x-kept')).toBe('yes');
      expect(response.headers.getSetCookie()).toEqual(['bge.session_token=; Max-Age=0; Path=/']);
      expect(response.headers.get('content-length')).toBeNull();
      await expect(response.json()).resolves.toEqual(failed);
    });

    it('passes a coded 500 with no storage failure through (#894)', async () => {
      const handle = createAuthRequestHandler(async () => betterAuths500(), { render: (key) => key });

      const response = await handle(anyRequest());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual(await betterAuths500().json());
    });

    it.each([
      ["better-auth's coded 500", betterAuths500],
      ['a 401', () => Response.json({ code: 'UNAUTHORIZED', message: 'Unauthorized' }, { status: 401 })],
      ['a 400', () => Response.json({ code: 'INVALID_TOKEN', message: 'Invalid token' }, { status: 400 })],
    ])('answers %s after a storage failure 503 AUTH_UNAVAILABLE (#894)', async (_, answer) => {
      const handle = createAuthRequestHandler(
        async () => {
          noteStorageFailure();
          return answer();
        },
        { render: (key) => key },
      );

      const response = await handle(anyRequest());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual(unavailable);
    });

    it("leaves better-auth's cookies off the 503, since they rest on the failed storage (#894)", async () => {
      const handle = createAuthRequestHandler(
        async () => {
          noteStorageFailure();
          const headers = new Headers();
          headers.append('set-cookie', 'bge.session_token=; Max-Age=0; Path=/');
          return Response.json({ code: 'UNAUTHORIZED' }, { status: 401, headers });
        },
        { render: (key) => key },
      );

      const response = await handle(anyRequest());

      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('passes a success after a storage failure through, as better-auth gave it (#894)', async () => {
      const handle = createAuthRequestHandler(
        async () => {
          noteStorageFailure();
          return Response.json({ status: true });
        },
        { render: (key) => key },
      );

      const response = await handle(anyRequest());

      expect(response.status).toBe(200);
    });
  });
});
