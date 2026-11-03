import { betterAuth } from 'better-auth';
import Keyv from 'keyv';
import type { CompleteAuthStorage } from '../auth-storage';
import { memoryAuthStorage } from '../memory-auth-storage.fixture';
import { createAppSignInStore } from './app-sign-in-store';
import { APP_SIGN_IN_PATHS, appSignIn } from './app-sign-in.plugin';

const ORIGIN = 'http://localhost:3000';

/** The example pair from RFC 7636, Appendix B. */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/**
 * An instance with the plugin and one social provider whose authorization URL
 * is built locally, so a sign-in can start and a provider-leg error can come
 * back without a provider to talk to. Its records live in a secondary storage,
 * in memory here and Redis in the api, so better-auth keeps the OAuth state
 * there and signs a `state` cookie, as it does in the api.
 */
function createInstance(options: { readonly storage?: CompleteAuthStorage; readonly errorURL?: string } = {}) {
  return betterAuth({
    telemetry: { enabled: false },
    logger: { disabled: true },
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    baseURL: `${ORIGIN}/api/auth`,
    basePath: '/api/auth',
    advanced: { cookiePrefix: 'bge_auth_' },
    ...(options.errorURL === undefined ? {} : { onAPIError: { errorURL: options.errorURL } }),
    secondaryStorage: options.storage ?? memoryAuthStorage(new Keyv({ throwOnErrors: true })),
    socialProviders: { github: { clientId: 'client-id', clientSecret: 'client-secret' } },
    plugins: [appSignIn({ render: (key) => `rendered:${key}`, issuer: ORIGIN })],
  });
}

type Instance = ReturnType<typeof createInstance>;

/** A browser's GET, with no redirect followed. */
const get = (auth: Instance, path: string, cookie?: string): Promise<Response> =>
  auth.handler(new Request(`${ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } }));

const startPath = (params: Record<string, string>): string =>
  `/api/auth${APP_SIGN_IN_PATHS.start}?${new URLSearchParams(params).toString()}`;

const VALID_START = {
  provider: 'github',
  redirect_uri: 'bge://oauth',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'app-state',
};

/** Where a redirect sends the browser. */
const locationOf = (response: Response): URL => new URL(response.headers.get('location') ?? '', ORIGIN);

/** Each `Set-Cookie` as the `name=value` a `Cookie` header sends back. */
const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

describe('appSignIn', () => {
  describe('start', () => {
    // A bad return address goes to the server's error page, since nothing can
    // go back to the app; then the request; then the provider (#1019).
    it('checks the return address, then the request, then the provider (#1019)', async () => {
      const auth = createInstance();
      const bad = { ...VALID_START, provider: 'nope', code_challenge_method: 'plain' };

      const addressRefused = await get(auth, startPath({ ...bad, redirect_uri: 'https://attacker.example/cb' }));
      expect(addressRefused.status).toBe(302);
      expect(locationOf(addressRefused).href).toBe(
        `${ORIGIN}/api/auth/error?error=APP_SIGN_IN_RETURN_ADDRESS_REFUSED&error_description=rendered%3Aerrors.auth.app_sign_in_return_address_refused`,
      );
      expect(addressRefused.headers.getSetCookie()).toEqual([]);

      const requestRefused = await get(auth, startPath(bad));
      expect(requestRefused.headers.get('location')).toBe(
        `bge://oauth?error=APP_SIGN_IN_REQUEST_INVALID&error_description=rendered%3Aerrors.auth.app_sign_in_request_invalid&state=app-state&iss=${encodeURIComponent(ORIGIN)}`,
      );

      const providerRefused = await get(auth, startPath({ ...VALID_START, provider: 'nope' }));
      expect(providerRefused.headers.get('location')).toBe(
        `bge://oauth?error=oauth_provider_not_found&error_description=rendered%3Aerrors.auth.app_sign_in_provider_not_found&state=app-state&iss=${encodeURIComponent(ORIGIN)}`,
      );
      expect(providerRefused.headers.getSetCookie()).toEqual([]);
    });

    // better-auth's callback sends its errors to `onAPIError.errorURL` when
    // one is set, so app sign-in's go there too, not to a page of their own.
    it('sends a refused return address to the error page better-auth’s callback uses (#1019)', async () => {
      const auth = createInstance({ errorURL: 'https://client.example/sign-in-error' });

      const response = await get(auth, startPath({ ...VALID_START, redirect_uri: 'https://attacker.example/cb' }));

      const page = locationOf(response);
      expect(`${page.origin}${page.pathname}`).toBe('https://client.example/sign-in-error');
      expect(page.searchParams.get('error')).toBe('APP_SIGN_IN_RETURN_ADDRESS_REFUSED');
    });

    // The flow is stored, then the storage fails before the provider's
    // address is built: the app is told, with a code and a message, and the
    // flow is removed rather than left to expire (#1019).
    it('tells the app, and leaves no flow behind, when the sign-in can’t start (#1019)', async () => {
      const base = memoryAuthStorage(new Keyv({ throwOnErrors: true }));
      const flowKeys: string[] = [];
      const storage: CompleteAuthStorage = {
        ...base,
        async set(key, value, ttl) {
          if (flowKeys.length > 0) {
            throw new Error('the verification store is unreachable');
          }
          await base.set(key, value, ttl);
          if (key.includes('app-sign-in-flow:')) {
            flowKeys.push(key);
          }
        },
      };
      const auth = createInstance({ storage });

      const response = await get(auth, startPath(VALID_START));

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        `bge://oauth?error=APP_SIGN_IN_UNAVAILABLE&error_description=rendered%3Aerrors.auth.app_sign_in_unavailable&state=app-state&iss=${encodeURIComponent(ORIGIN)}`,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(flowKeys).toHaveLength(1);
      await expect(base.get(flowKeys[0])).resolves.toBeUndefined();
    });

    // better-auth checks its state cookie on the callback, so it has to land
    // in the browser that goes to the provider (#1019).
    it('starts the provider sign-in in the browser, with better-auth’s state cookie and no caching (#1019)', async () => {
      const auth = createInstance();

      const response = await get(auth, startPath(VALID_START));

      expect(response.status).toBe(302);
      const authorization = locationOf(response);
      expect(authorization.origin).toBe('https://github.com');
      expect(authorization.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`);
      expect(authorization.searchParams.get('state')).toEqual(expect.any(String));
      expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^bge_auth_\.state=/)]);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
    });
  });

  describe('return', () => {
    /** Starts a sign-in, then cancels it at the provider: where the callback sends the browser. */
    const cancelledAtProvider = async (auth: Instance, error: string, description: string): Promise<URL> => {
      const start = await get(auth, startPath(VALID_START));
      const state = locationOf(start).searchParams.get('state') ?? '';
      const callback = await get(
        auth,
        `/api/auth/callback/github?${new URLSearchParams({ error, error_description: description, state }).toString()}`,
        cookiesOf(start),
      );

      return locationOf(callback);
    };

    // The provider's text is passed through to the app, so it is bounded.
    it('carries a provider error to the app, cut to its limits, with the app’s state and the issuer (#1019)', async () => {
      const auth = createInstance();
      const returnPage = await cancelledAtProvider(auth, 'e'.repeat(200), 'd'.repeat(2000));
      expect(returnPage.pathname).toBe(`/api/auth${APP_SIGN_IN_PATHS.return}`);

      const response = await get(auth, `${returnPage.pathname}${returnPage.search}`);

      expect(response.headers.get('cache-control')).toBe('no-store');
      const app = new URL(response.headers.get('location') ?? '');
      expect(`${app.protocol}//${app.host}`).toBe('bge://oauth');
      expect(app.searchParams.get('error')).toBe('e'.repeat(128));
      expect(app.searchParams.get('error_description')).toBe('d'.repeat(1024));
      expect(app.searchParams.get('state')).toBe('app-state');
      expect(app.searchParams.get('iss')).toBe(ORIGIN);
      expect(app.searchParams.has('code')).toBe(false);
    });
  });

  describe('token', () => {
    /** A POST to the token route, with `body` sent as it is. */
    const postToken = (auth: Instance, contentType: string, body: string): Promise<Response> =>
      auth.handler(
        new Request(`${ORIGIN}/api/auth${APP_SIGN_IN_PATHS.token}`, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        }),
      );

    /** The app's exchange of `code` with the verifier its challenge came from. */
    const exchange = (auth: Instance, code: string): Promise<Response> =>
      postToken(auth, 'application/json', JSON.stringify({ code, code_verifier: VERIFIER }));

    /** A user, and a code issued for them that the app hasn't exchanged yet. */
    const issuedCode = async (auth: Instance) => {
      const context = await auth.$context;
      const user = await context.internalAdapter.createUser(
        { email: 'app-user@example.test', name: 'app-user', emailVerified: true },
        { method: 'admin' },
      );
      const code = await createAppSignInStore(context.internalAdapter).issueCode({
        userId: user.id,
        codeChallenge: CHALLENGE,
      });

      return { user, code };
    };

    // A body the server can't read never reaches the store, so the app can
    // send a proper one after, and it gets this server's code and message,
    // not the body parser's (#1019).
    it.each([
      ['malformed JSON', 'application/json', () => '{"code":'],
      ['a JSON array', 'application/json', () => '[]'],
      ['a form', 'application/x-www-form-urlencoded', (code: string) => `code=${code}&code_verifier=${VERIFIER}`],
      ['text', 'text/plain', (code: string) => JSON.stringify({ code, code_verifier: VERIFIER })],
    ])('answers %s with APP_SIGN_IN_REQUEST_INVALID and keeps the code (#1019)', async (_case, contentType, body) => {
      const auth = createInstance();
      const { user, code } = await issuedCode(auth);

      const unreadable = await postToken(auth, contentType, body(code));

      expect(unreadable.status).toBe(400);
      await expect(unreadable.json()).resolves.toEqual({
        code: 'APP_SIGN_IN_REQUEST_INVALID',
        message: 'rendered:errors.auth.app_sign_in_request_invalid',
      });
      const proper = await exchange(auth, code);
      expect(proper.status).toBe(200);
      await expect(proper.json()).resolves.toMatchObject({ user: { id: user.id } });
    });

    // A user can be deleted while their code waits. In the api, provisioning
    // gives every user preference, profile and role rows that a delete doesn't
    // cascade to, and writes them after the callback answers. An end-to-end
    // test would have to wait for those and delete them first, which ties it
    // to provisioning's tables; here better-auth's own adapter deletes the user.
    it('refuses the code of a user deleted after it was issued (#1019)', async () => {
      const auth = createInstance();
      const context = await auth.$context;
      const user = await context.internalAdapter.createUser(
        { email: 'deleted-later@example.test', name: 'deleted-later', emailVerified: true },
        { method: 'admin' },
      );
      const store = createAppSignInStore(context.internalAdapter);
      const exchangedFirst = await store.issueCode({ userId: user.id, codeChallenge: CHALLENGE });
      const exchangedAfter = await store.issueCode({ userId: user.id, codeChallenge: CHALLENGE });

      // While the user exists, a code is exchanged for a session.
      const control = await exchange(auth, exchangedFirst);
      expect(control.status).toBe(200);
      await expect(control.json()).resolves.toMatchObject({ token: expect.any(String), user: { id: user.id } });

      await context.internalAdapter.deleteUser(user.id);
      const response = await exchange(auth, exchangedAfter);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: 'APP_SIGN_IN_CODE_INVALID',
        message: 'rendered:errors.auth.app_sign_in_code_invalid',
      });
    });
  });

  // better-auth's own sign-in limit, which matches only paths starting with
  // `/sign-in` (#1019).
  it('limits start and token to three requests in ten seconds, and nothing else (#1019)', () => {
    const rules = appSignIn({ render: (key) => key, issuer: ORIGIN }).rateLimit;
    const ruleFor = (path: string) => rules.find((rule) => rule.pathMatcher(path));

    expect(ruleFor('/app-sign-in/start')).toMatchObject({ window: 10, max: 3 });
    expect(ruleFor('/app-sign-in/token')).toMatchObject({ window: 10, max: 3 });
    for (const path of ['/app-sign-in/return', '/app-sign-in/start/x', '/app-sign-in', '/sign-in/social']) {
      expect(ruleFor(path)).toBeUndefined();
    }
  });
});
