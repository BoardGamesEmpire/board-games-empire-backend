import { AUTH_CLIENT_IP_HEADER } from '@bge/auth';
import { createActors, SET_AUTH_TOKEN_HEADER, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { apiCacheTtlMs } from '../support/api-cache';
import { postToAuth } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const SIGN_IN_PATH = '/api/auth/sign-in/email';
const GET_SESSION_PATH = '/api/auth/get-session';

/**
 * The session token a credential carries, which better-auth names its storage
 * key after: the part before the signature, if the credential is signed.
 */
const sessionToken = (credential: string) => decodeURIComponent(credential).split('.')[0];

/**
 * Where better-auth keeps a session, and what it records about the client
 * (#640). The session store and the client's address are both decided outside
 * better-auth, in `AuthModule` and `main.ts`, so only the running api shows
 * them wired.
 */
describe("better-auth's sessions", () => {
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

  it('are kept in Redis until the session expires (#640)', async () => {
    // better-auth gives the TTL in seconds. Read as milliseconds, as it was,
    // a seven-day session was dropped after about ten minutes.
    const actor = await actors.user();
    const session = await request(baseUrl).get(GET_SESSION_PATH).set(actor.headers).expect(200);

    const ttl = await apiCacheTtlMs(`auth_${sessionToken(actor.credentials.token)}`);
    const lifeLeft = new Date(session.body.session.expiresAt).getTime() - Date.now();

    // better-auth floors the TTL to whole seconds, and the two reads are
    // moments apart.
    expect(Math.abs(ttl - lifeLeft)).toBeLessThan(5_000);
  });

  it('record the address the api saw, not one the client sent as its own (#640)', async () => {
    // better-auth reads the address only from the header the api writes, and
    // keys its rate limits on the same one. A client that could set it would
    // pick its own rate-limit bucket. The header is named by the constant
    // better-auth is configured with, so a rename can't leave this test
    // forging a header nothing reads.
    const actor = await actors.user();

    const signIn = await postToAuth(baseUrl, SIGN_IN_PATH)
      .set(AUTH_CLIENT_IP_HEADER, '192.0.2.1')
      .send({ email: actor.user.email, password: actor.password })
      .expect(200);
    const session = await request(baseUrl)
      .get(GET_SESSION_PATH)
      .set('Authorization', `Bearer ${signIn.headers[SET_AUTH_TOKEN_HEADER]}`)
      .expect(200);

    expect(session.body.session.ipAddress).toBe('127.0.0.1');
  });
});
