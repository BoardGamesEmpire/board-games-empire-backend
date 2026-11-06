import type { I18nPath } from '@bge/i18n';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuthMiddleware } from 'better-auth/api';
import { bearer } from 'better-auth/plugins';
import { createHmac } from 'node:crypto';
import { createProviderLinkFreshness, PROVIDER_LINK_NEEDS_RECENT_SIGN_IN } from './provider-link-freshness';

const SECRET = 'a-unit-test-secret-of-at-least-32-characters';
const BASE_URL = 'http://localhost:3000';
const COOKIE_NAME = 'better-auth.session_token';

/** One day, in seconds, as `authFactory` sets `session.freshAge`. */
const FRESH_AGE = 86_400;
const FRESH_AGE_MS = FRESH_AGE * 1000;

const NOW = Date.parse('2026-11-05T12:00:00Z');

const render = (key: I18nPath): string => `rendered:${key}`;

const REFUSAL = {
  code: PROVIDER_LINK_NEEDS_RECENT_SIGN_IN,
  message: render('errors.auth.provider_link_needs_recent_sign_in'),
};

/**
 * A real better-auth instance over the memory adapter, with the bearer plugin
 * `authFactory` runs and the check as its before hook, so the session checked
 * is resolved by better-auth's own code. No provider is configured: a link the
 * check lets through reaches the route, which answers 404 for the unknown
 * provider once it has found a session, and 401 when it finds none.
 */
async function instance(freshAge = FRESH_AGE) {
  const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] };
  const freshness = createProviderLinkFreshness({ render, now: () => NOW });
  const auth = betterAuth({
    telemetry: { enabled: false },
    logger: { disabled: true },
    secret: SECRET,
    baseURL: BASE_URL,
    database: memoryAdapter(db),
    session: { freshAge },
    plugins: [bearer()],
    hooks: { before: createAuthMiddleware((context) => freshness.beforeRoute(context)) },
  });
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    { email: 'alice@example.test', name: 'alice', emailVerified: true },
    { method: 'email-password' },
  );

  /** A session for the user, signed in `ageMs` before now, and its token. */
  const sessionSignedInAgo = async (ageMs: number): Promise<string> => {
    const { token } = await context.internalAdapter.createSession(user.id);
    const row = db['session'].find((session) => session['token'] === token);
    if (!row) {
      throw new Error('the memory adapter holds no row for the new session');
    }
    row['createdAt'] = new Date(NOW - ageMs);
    row['expiresAt'] = new Date(Date.now() + FRESH_AGE_MS * 7);

    return token;
  };

  const post = async (path: string, headers: Record<string, string>) => {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL, ...headers },
        body: JSON.stringify({ provider: 'nowhere', callbackURL: '/' }),
      }),
    );
    const body = (await response.json().catch(() => undefined)) as { code?: string; message?: string } | undefined;

    return { status: response.status, body };
  };

  return {
    context,
    sessionSignedInAgo,
    post,
    link: (headers: Record<string, string>) => post('/link-social', headers),
  };
}

/** The instance's signature over `token`, in better-call's form: standard base64, padded. */
const signatureOf = (token: string): string => createHmac('sha256', SECRET).update(token).digest('base64');

/** A signed session cookie for `token`, as better-auth sets it. */
const cookieFor = (token: string): string => `${COOKIE_NAME}=${encodeURIComponent(`${token}.${signatureOf(token)}`)}`;

const bearerFor = (credential: string): string => `Bearer ${credential}`;

/** The route went on with a session: no refusal, no 401, only the unknown provider's 404. */
const STARTED = 404;

describe('createProviderLinkFreshness', () => {
  it('starts a link from a session signed in within freshAge (#913)', async () => {
    const { sessionSignedInAgo, link } = await instance();
    const fresh = await sessionSignedInAgo(FRESH_AGE_MS - 1_000);

    await expect(link({ cookie: cookieFor(fresh) })).resolves.toMatchObject({ status: STARTED });
  });

  // better-auth's own fresh-session check refuses at `>=`, so a session exactly
  // freshAge old is stale here too.
  it('refuses a link from a session signed in freshAge ago or longer, with PROVIDER_LINK_NEEDS_RECENT_SIGN_IN (#913)', async () => {
    const { sessionSignedInAgo, link } = await instance();

    for (const ageMs of [FRESH_AGE_MS, FRESH_AGE_MS + 1, FRESH_AGE_MS * 30]) {
      const stale = await sessionSignedInAgo(ageMs);

      await expect(link({ cookie: cookieFor(stale) })).resolves.toEqual({ status: 403, body: REFUSAL });
    }
  });

  it('leaves every route but /link-social alone (#913)', async () => {
    const { sessionSignedInAgo, post } = await instance();
    const stale = await sessionSignedInAgo(FRESH_AGE_MS * 2);

    const { status, body } = await post('/sign-out', { cookie: cookieFor(stale) });

    expect(status).toBe(200);
    expect(body?.code).toBeUndefined();
  });

  // Every before hook sees the request as sent. The bearer plugin turns the
  // credential into the session cookie only after all of them have run, so a
  // check that read only the cookie would let every bearer caller through.
  it('checks the session a bearer credential names, signed or bare, as the route will use it (#913)', async () => {
    const { sessionSignedInAgo, link } = await instance();
    const stale = await sessionSignedInAgo(FRESH_AGE_MS);
    const fresh = await sessionSignedInAgo(1_000);

    for (const credential of [`${stale}.${signatureOf(stale)}`, stale]) {
      await expect(link({ authorization: bearerFor(credential) })).resolves.toEqual({ status: 403, body: REFUSAL });
    }

    // The plugin writes the credential's session over the cookie's.
    for (const credential of [`${fresh}.${signatureOf(fresh)}`, fresh]) {
      await expect(link({ authorization: bearerFor(credential), cookie: cookieFor(stale) })).resolves.toMatchObject({
        status: STARTED,
      });
    }
  });

  // The bearer plugin ignores a bearer credential it can't verify, and the
  // route then uses the cookie's session. Each credential here names a fresh
  // session with its real signature, altered in a way Node's lenient base64
  // decoder reads past and the plugin's strict one refuses, or with no valid
  // signature at all. Sent beside a stale cookie, each must be refused: a
  // check reading the credential its own way would see the fresh session and
  // let the stale one link a provider.
  it('checks the cookie’s session when the bearer plugin ignores the credential, however it is malformed (#913)', async () => {
    const { sessionSignedInAgo, link } = await instance();
    const stale = await sessionSignedInAgo(FRESH_AGE_MS);

    // A fresh session whose signature holds two of standard base64's own
    // characters, '+' or '/', so one can be written in base64url's.
    const { fresh, signature } = await (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const token = await sessionSignedInAgo(1_000);
        if ((signatureOf(token).match(/[+/]/g) ?? []).length >= 2) {
          return { fresh: token, signature: signatureOf(token) };
        }
      }
      throw new Error('no signature with two of standard base64’s own characters in 100 sessions');
    })();
    const at = signature.search(/[+/]/);
    const mixed = `${signature.slice(0, at)}${signature[at] === '+' ? '-' : '_'}${signature.slice(at + 1)}`;

    const credentials = {
      'a stray character after the signature': `${fresh}.${signature.replace(/=$/, '')}!`,
      'a stray character inside the signature': `${fresh}.${signature.slice(0, 10)}!${signature.slice(10)}`,
      'both base64 alphabets at once': `${fresh}.${mixed}`,
      'a forged signature': `${fresh}.forged-signature`,
      'an empty signature': `${fresh}.`,
    };

    for (const [shape, credential] of Object.entries(credentials)) {
      const answer = await link({ authorization: bearerFor(credential), cookie: cookieFor(stale) });

      expect({ shape, ...answer }).toEqual({ shape, status: 403, body: REFUSAL });
    }
  });

  // The route's own session check answers these with 401. A 403 saying "sign
  // in again" would be a different answer to a request that isn't signed in.
  it('leaves a request naming no session, or an unknown one, to the route’s own 401 (#913)', async () => {
    const { link } = await instance();

    const requests: Record<string, string>[] = [
      {},
      { authorization: bearerFor('unknown.forged-signature') },
      { authorization: bearerFor(`unknown.${signatureOf('unknown')}`) },
      { cookie: cookieFor('unknown') },
    ];

    for (const headers of requests) {
      await expect(link(headers)).resolves.toMatchObject({ status: 401 });
    }
  });

  // A store that can't be read leaves the session's age unknown, so the link
  // is not started on a guess.
  it('fails a link whose session can’t be read, rather than starting it (#913)', async () => {
    const { context, sessionSignedInAgo, link } = await instance();
    const stale = await sessionSignedInAgo(FRESH_AGE_MS);
    jest.spyOn(context.internalAdapter, 'findSession').mockRejectedValue(new Error('Connection is closed.'));

    const { status } = await link({ cookie: cookieFor(stale) });

    expect(status).toBe(500);
  });

  it('checks nothing when freshAge is 0, as better-auth does (#913)', async () => {
    const { sessionSignedInAgo, link } = await instance(0);
    const stale = await sessionSignedInAgo(FRESH_AGE_MS * 30);

    await expect(link({ cookie: cookieFor(stale) })).resolves.toMatchObject({ status: STARTED });
  });
});
