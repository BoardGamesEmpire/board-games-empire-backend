import type { PrismaClient } from '@bge/database';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Keyv from 'keyv';
import { authFactory } from './auth-factory';
import { createAuthRequestHandler } from './auth-request-handler';
import { createAuthStorage } from './auth-storage';
import { AUTH_CLIENT_IP_HEADER } from './constants';

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
const noUsers = new Proxy(
  {},
  { get: () => new Proxy({}, { get: (_model, operation) => async () => (operation === 'findMany' ? [] : null) }) },
) as PrismaClient;

/** A store whose connection drops on every read, as Redis's does when it goes away. */
class ReadsFail extends Map<string, unknown> {
  override get(): unknown {
    throw new Error('Connection is closed.');
  }
}

/**
 * The api's handler for `/api/auth/*` over a real instance, with better-auth's
 * limiter on. better-auth turns it on only when NODE_ENV is production, which
 * it reads once, at import, so it is switched on in the instance's context.
 * Messages render as their catalog keys.
 */
async function servedOver(store: Keyv) {
  store.on('error', () => undefined);
  const auth = authFactory(noUsers, config, createAuthStorage(store));
  (await auth.$context).rateLimit.enabled = true;

  return createAuthRequestHandler(auth.handler, { render: (key) => key });
}

const signIn = (handle: (request: Request) => Promise<Response>) =>
  handle(
    new Request('http://localhost:33333/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CLIENT_IP_HEADER]: '198.51.100.4' },
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
    await expect(refused.json()).resolves.toEqual({ code: 'RATE_LIMITED', message: 'errors.auth.rate_limited' });
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
    await expect(response.json()).resolves.toEqual({ code: 'AUTH_UNAVAILABLE', message: 'errors.auth.unavailable' });
    expect(logged).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Connection is closed.'));
    logged.mockRestore();
  });

  it('passes every other answer through as better-auth gave it, its own code included (#640)', async () => {
    const handle = await servedOver(new Keyv({ throwOnErrors: true }));

    const response = await signIn(handle);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  });
});
