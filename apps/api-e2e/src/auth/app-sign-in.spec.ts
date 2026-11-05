import { APP_SIGN_IN_FLOW_KEY } from '@bge/auth';
import { SIGN_IN_ANONYMOUS_PATH, waitForProvisionedRoleNames } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { apiCacheHas } from '../support/api-cache';
import {
  APP_SIGN_IN_RETURN_PATH,
  APP_USER_AGENT,
  type AppSignInThroughProvider,
  appSignInThroughProvider,
  exchangeAppSignInCode,
  nextLocation,
  pkcePair,
  postAppSignInToken,
  startAppSignIn,
  type StartedAppSignIn,
} from '../support/app-sign-in';
import { requireBaseUrl, SIGNED_FAKE_PROVIDER_ID } from '../support/e2e-env';
import { ID_TOKEN_FAULTS } from '../support/fake-sign-in-provider';
import { useSettingSwitch } from '../support/setting-switch';
import {
  cookiePairs,
  fakeProviderUrl,
  registerTicket,
  sessionCookieOf,
  signInThroughProvider,
} from '../support/sign-in-provider';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const DISCOVERY_PATH = '/.well-known/bge-identity';
const GET_SESSION_PATH = '/api/auth/get-session';
const LIST_SESSIONS_PATH = '/api/auth/list-sessions';
const ERROR_PAGE_PATH = '/api/auth/error';

/** What the app is told, by code: the message catalog's sentences, written out here as the client sees them. */
const MESSAGES = {
  APP_SIGN_IN_RETURN_ADDRESS_REFUSED:
    "The app asked to receive your sign-in at an address this server doesn't send sign-ins to, so the sign-in was stopped. Update the app, then try again",
  APP_SIGN_IN_REQUEST_INVALID:
    "The app's sign-in request was incomplete or couldn't be read, so the sign-in was stopped. Start again from the app",
  APP_SIGN_IN_FLOW_INVALID: 'This sign-in has expired or was already finished. Start again from the app',
  APP_SIGN_IN_CODE_INVALID: 'This sign-in code is no longer valid. Start the sign-in again from the app',
  oauth_provider_not_found:
    "That sign-in provider isn't available on this server, so the sign-in was stopped. Choose another way to sign in, or try again later",
} as const;

/** The response to an exchange whose code is gone, unknown, or whose verifier doesn't match. */
const CODE_INVALID_BODY = { code: 'APP_SIGN_IN_CODE_INVALID', message: MESSAGES.APP_SIGN_IN_CODE_INVALID };

/** The response to an exchange whose body the server can't read. */
const REQUEST_INVALID_BODY = { code: 'APP_SIGN_IN_REQUEST_INVALID', message: MESSAGES.APP_SIGN_IN_REQUEST_INVALID };

/** A session credential's cookie: the token, the cached session data or its chunks, or "don't remember me". */
const CREDENTIAL_COOKIE = /\.(session_token|session_data|dont_remember)(\.\d+)?$/;

/** The last-login-method plugin's cookie, which hints at how the browser last signed in. */
const LAST_LOGIN_METHOD_COOKIE = /last_used_login_method$/;

/** The names of the session credentials a response sets or expires. */
const credentialCookiesIn = (setCookie: readonly string[]): string[] =>
  cookiePairs(setCookie)
    .map((pair) => pair.split('=')[0])
    .filter((name) => CREDENTIAL_COOKIE.test(name));

/** The token route's answer to a good exchange. */
interface ExchangeAnswer {
  readonly token: string;
  readonly user: { readonly id: string };
}

const answerOf = async (exchange: Response): Promise<ExchangeAnswer> => (await exchange.json()) as ExchangeAnswer;

/** Whether `url` is the official app's return address, with `path` as its path. */
const isAppAddress = (url: URL, path = ''): boolean =>
  url.protocol === 'bge:' && url.host === 'oauth' && url.pathname === path;

/** The app's query, as the app reads it. */
const queryOf = (url: URL): Record<string, string> => Object.fromEntries(url.searchParams);

/**
 * Signing in from a native app (#1019), end to end: the app opens the start
 * route in a browser, the person signs in at the fake provider, the callback
 * hands the session to the app as a code at `bge://oauth`, and the app
 * exchanges it, with its PKCE verifier, for a session of its own.
 */
describe('signing in from a native app (#1019)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  /** A provider subject no other test uses, with an email and a username of its own. */
  const freshIdentity = () => {
    const unique = randomUUID().replaceAll('-', '').slice(0, 12);

    return { sub: randomUUID(), email: `e2e-app-${unique}@e2e.invalid`, username: `e2e-app-${unique}` };
  };

  /** The claims a provider that vouches for the email returns for `identity`. */
  const claimsOf = (identity: ReturnType<typeof freshIdentity>) => ({
    sub: identity.sub,
    email: identity.email,
    email_verified: true,
    preferred_username: identity.username,
  });

  const userIdByEmail = async (email: string): Promise<string> =>
    (await db.client.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;

  /** The issuer discovery publishes, which every redirect to the app carries as `iss`. */
  const issuer = async (): Promise<string> => (await request(baseUrl).get(DISCOVERY_PATH).expect(200)).body.issuer;

  /** The user a credential signs in as, if it still does. */
  const sessionUserOf = async (headers: Record<string, string>): Promise<string | undefined> =>
    (await request(baseUrl).get(GET_SESSION_PATH).set(headers).expect(200)).body?.user?.id;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** What the fake provider recorded of one sign-in. */
  const ticketOf = async (ticket: string) =>
    (await request(fakeProviderUrl()).get(`/tickets/${ticket}`).expect(200)).body;

  /** The code the browser carried to the app. */
  const codeOf = (result: AppSignInThroughProvider): string => {
    const code = result.appLocation.searchParams.get('code');
    if (code === null) {
      throw new Error(`the app received no code: ${result.appLocation.href}`);
    }

    return code;
  };

  /**
   * The person cancels at the provider: the provider sends the browser back to
   * the callback with `error=access_denied` and the flow's state. Where the
   * callback sends the browser next, which is the flow's return page, unfetched.
   */
  const cancelAtProvider = (start: StartedAppSignIn): Promise<URL> => {
    const callback = new URL(`${baseUrl}/api/auth/callback/fake`);
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('state', start.location.searchParams.get('state') ?? '');

    return nextLocation(baseUrl, callback, cookiePairs(start.setCookie).join('; '));
  };

  describe('the hand-off', () => {
    it('returns to bge://oauth with a code, the app’s state and the server’s issuer (#1019)', async () => {
      const result = await appSignInThroughProvider(baseUrl, claimsOf(freshIdentity()), { state: 'a&b=c #ü' });

      // The callback sends the browser straight to the app, and nothing caches it.
      expect(result.callback.status).toBe(302);
      expect(isAppAddress(result.callback.location)).toBe(true);
      expect(result.callback.headers.get('cache-control')).toBe('no-store');
      expect(result.callback.headers.get('pragma')).toBe('no-cache');
      expect(Object.keys(queryOf(result.appLocation))).toEqual(['code', 'state', 'iss']);
      expect(codeOf(result)).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(result.appLocation.searchParams.get('state')).toBe('a&b=c #ü');
      expect(result.appLocation.searchParams.get('iss')).toBe(await issuer());
    });

    it('keeps the return address’s path (#1019)', async () => {
      const result = await appSignInThroughProvider(baseUrl, claimsOf(freshIdentity()), {
        returnAddress: 'bge://oauth/server-7',
      });

      expect(isAppAddress(result.appLocation, '/server-7')).toBe(true);
      expect(codeOf(result)).toEqual(expect.any(String));
    });

    // The callback is the last step on the server, so a tab closed anywhere
    // after the provider leaves nothing behind.
    it('leaves no session in the browser, even if the tab closes after the provider (#1019)', async () => {
      const result = await appSignInThroughProvider(baseUrl, claimsOf(freshIdentity()));

      expect(credentialCookiesIn(result.callback.setCookie)).toEqual([]);
      expect(result.callback.headers.has('set-auth-token')).toBe(false);

      const exchange = await exchangeAppSignInCode(baseUrl, { code: codeOf(result), code_verifier: result.verifier });
      expect(exchange.status).toBe(200);
      const { token } = await answerOf(exchange);
      const own = await request(baseUrl).get(GET_SESSION_PATH).set(bearer(token)).expect(200);
      const listed = await request(baseUrl).get(LIST_SESSIONS_PATH).set(bearer(token)).expect(200);
      expect(listed.body.map((session: { id: string }) => session.id)).toEqual([own.body.session.id]);
    });

    it('keeps the browser’s own session when the app signs in as someone else (#1019)', async () => {
      const browserUser = freshIdentity();
      const web = await signInThroughProvider(baseUrl, claimsOf(browserUser));
      expect(web.cookie).not.toBe('');
      const appUser = freshIdentity();

      const result = await appSignInThroughProvider(baseUrl, claimsOf(appUser), { cookies: web.cookie });

      // Nothing is sent for the browser's session cookie: no new value, no expiry.
      expect(credentialCookiesIn(result.callback.setCookie)).toEqual([]);
      await expect(sessionUserOf({ Cookie: web.cookie })).resolves.toBe(await userIdByEmail(browserUser.email));
      const exchange = await exchangeAppSignInCode(baseUrl, { code: codeOf(result), code_verifier: result.verifier });
      expect(exchange.status).toBe(200);
      const { token } = await answerOf(exchange);
      await expect(sessionUserOf(bearer(token))).resolves.toBe(await userIdByEmail(appUser.email));
    });

    // The anonymous plugin's hook on the callback takes a sign-in from a
    // browser holding a guest's session for the guest's upgrade, and deletes
    // the guest. The app's sign-in isn't the browser's.
    it('keeps the browser’s guest when the app signs in from it (#1019)', async () => {
      const guestSignIn = await fetch(`${baseUrl}${SIGN_IN_ANONYMOUS_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: '{}',
      });
      expect(guestSignIn.status).toBe(200);
      const guestId = ((await guestSignIn.json()) as { user: { id: string } }).user.id;
      const guestCookie = sessionCookieOf(guestSignIn.headers.getSetCookie());
      expect(guestCookie).not.toBe('');
      // Provisioning's rows don't cascade, so while they exist a delete of the
      // guest fails and this test would pass whatever the hand-off did. Without
      // them, a delete goes through.
      await waitForProvisionedRoleNames(db.client, guestId, 'the guest');
      await db.client.userRole.deleteMany({ where: { userId: guestId } });
      await db.client.userProfile.deleteMany({ where: { userId: guestId } });
      await db.client.userPreferences.deleteMany({ where: { userId: guestId } });
      const appUser = freshIdentity();

      const result = await appSignInThroughProvider(baseUrl, claimsOf(appUser), { cookies: guestCookie });

      expect(codeOf(result)).toEqual(expect.any(String));
      await expect(db.client.user.findUnique({ where: { id: guestId }, select: { id: true } })).resolves.toEqual({
        id: guestId,
      });
      await expect(sessionUserOf({ Cookie: guestCookie })).resolves.toBe(guestId);
    });

    // The cookie says how the browser last signed in; the app's sign-in isn't
    // the browser's.
    it('leaves the browser’s last-login-method cookie alone (#1019)', async () => {
      const result = await appSignInThroughProvider(baseUrl, claimsOf(freshIdentity()));

      expect(codeOf(result)).toEqual(expect.any(String));
      const names = cookiePairs(result.callback.setCookie).map((pair) => pair.split('=')[0]);
      expect(names.filter((name) => LAST_LOGIN_METHOD_COOKIE.test(name))).toEqual([]);
    });
  });

  describe('refusing the app’s request', () => {
    // A code must never be sent anywhere but the app, so a refused address
    // keeps the browser on the server's own error page.
    it('refuses a return address that leaves the device, with the server’s error page (#1019)', async () => {
      const start = await startAppSignIn(baseUrl, { returnAddress: 'https://attacker.example/cb' });

      expect(start.status).toBe(302);
      expect(start.location.origin).toBe(new URL(baseUrl).origin);
      expect(start.location.pathname).toBe(ERROR_PAGE_PATH);
      expect(queryOf(start.location)).toEqual({
        error: 'APP_SIGN_IN_RETURN_ADDRESS_REFUSED',
        error_description: MESSAGES.APP_SIGN_IN_RETURN_ADDRESS_REFUSED,
      });
      expect(start.setCookie).toEqual([]);
    });

    it('refuses a repeated return address with the server’s error page (#1019)', async () => {
      const { challenge } = pkcePair();
      const start = await startAppSignIn(baseUrl, {
        query: `provider=fake&redirect_uri=bge://oauth&redirect_uri=bge://oauth/x&code_challenge=${challenge}&code_challenge_method=S256`,
      });

      expect(start.location.pathname).toBe(ERROR_PAGE_PATH);
      expect(start.location.searchParams.get('error')).toBe('APP_SIGN_IN_RETURN_ADDRESS_REFUSED');
      expect(start.setCookie).toEqual([]);
    });

    const repeatedChallenge = () => {
      const { challenge } = pkcePair();
      return `provider=fake&redirect_uri=bge://oauth&code_challenge=${challenge}&code_challenge=${challenge}&code_challenge_method=S256&state=kept`;
    };

    it.each([
      ['a plain challenge method', () => ({ method: 'plain', state: 'kept' }), 'kept'],
      ['a repeated code_challenge', () => ({ query: repeatedChallenge() }), 'kept'],
      ['a 1025-character state', () => ({ state: 's'.repeat(1025) }), undefined],
    ])('tells the app when its request is unusable: %s (#1019)', async (_case, request, echoedState) => {
      const start = await startAppSignIn(baseUrl, request());

      expect(isAppAddress(start.location)).toBe(true);
      expect(queryOf(start.location)).toEqual({
        error: 'APP_SIGN_IN_REQUEST_INVALID',
        error_description: MESSAGES.APP_SIGN_IN_REQUEST_INVALID,
        ...(echoedState === undefined ? {} : { state: echoedState }),
        iss: await issuer(),
      });
      expect(start.setCookie).toEqual([]);
    });

    it.each([
      ['unknown', 'provider=nope&'],
      ['missing', ''],
    ])('tells the app when the provider is %s (#1019)', async (_case, provider) => {
      const { challenge } = pkcePair();
      const start = await startAppSignIn(baseUrl, {
        query: `${provider}redirect_uri=bge://oauth&code_challenge=${challenge}&code_challenge_method=S256&state=kept`,
      });

      expect(isAppAddress(start.location)).toBe(true);
      expect(queryOf(start.location)).toEqual({
        error: 'oauth_provider_not_found',
        error_description: MESSAGES.oauth_provider_not_found,
        state: 'kept',
        iss: await issuer(),
      });
    });
  });

  describe('errors from the provider leg', () => {
    describe('while registration is closed', () => {
      const setRegistration = useSettingSwitch(() => db, 'allowUserRegistration');

      it('passes a provider refusal through to the app (#1019)', async () => {
        await setRegistration(false);
        const identity = freshIdentity();

        const result = await appSignInThroughProvider(baseUrl, claimsOf(identity), { state: 'kept' });

        expect(isAppAddress(result.appLocation)).toBe(true);
        expect(queryOf(result.appLocation)).toEqual({
          error: 'REGISTRATION_DISABLED',
          error_description: 'This server is not accepting new accounts',
          state: 'kept',
          iss: await issuer(),
        });
        await expect(db.client.user.count({ where: { email: identity.email } })).resolves.toBe(0);
      });
    });

    it('passes a cancel at the provider through to the app (#1019)', async () => {
      const start = await startAppSignIn(baseUrl, { state: 'kept' });

      const returnPage = await cancelAtProvider(start);
      expect(returnPage.pathname).toBe(APP_SIGN_IN_RETURN_PATH);
      const app = await nextLocation(baseUrl, returnPage);

      expect(isAppAddress(app)).toBe(true);
      expect(queryOf(app)).toEqual({ error: 'access_denied', state: 'kept', iss: await issuer() });
    });

    it('signs in through a provider that sends an ID token (#1019)', async () => {
      const result = await appSignInThroughProvider(baseUrl, claimsOf(freshIdentity()), {
        providerId: SIGNED_FAKE_PROVIDER_ID,
      });

      expect(codeOf(result)).toEqual(expect.any(String));
      const recorded = await ticketOf(result.ticket);
      expect(recorded.nonce).toEqual(expect.any(String));
      expect(recorded.nonce).toBe(result.authorization.searchParams.get('nonce'));
      // UserInfo is asked as well, for what the token leaves out (#993).
      expect(recorded.userInfoCalls).toBe(1);
    });

    it.each(ID_TOKEN_FAULTS)('tells the app when the provider’s ID token is refused: %s (#1019)', async (idToken) => {
      const identity = freshIdentity();

      const result = await appSignInThroughProvider(baseUrl, claimsOf(identity), {
        providerId: SIGNED_FAKE_PROVIDER_ID,
        idToken,
        state: 'kept',
      });

      expect(isAppAddress(result.appLocation)).toBe(true);
      expect(queryOf(result.appLocation)).toEqual({
        error: 'unable_to_get_user_info',
        state: 'kept',
        iss: await issuer(),
      });
      await expect(db.client.user.count({ where: { email: identity.email } })).resolves.toBe(0);
    });

    // better-auth's state cookie lasts 300 seconds and its state record ten
    // minutes. A browser back from the provider in between no longer sends the
    // cookie, and the app learns the sign-in must start again (#1050).
    it('tells the app when its sign-in outlived the state cookie (#1050)', async () => {
      const start = await startAppSignIn(baseUrl, { state: 'kept' });
      const ticket = await registerTicket(fakeProviderUrl(), claimsOf(freshIdentity()));
      const authorize = new URL(start.location);
      authorize.searchParams.set('ticket', ticket);
      const callbackUrl = await nextLocation(baseUrl, authorize);

      const returnPage = await nextLocation(baseUrl, callbackUrl);
      expect(returnPage.pathname).toBe(APP_SIGN_IN_RETURN_PATH);
      const app = await nextLocation(baseUrl, returnPage);

      expect(isAppAddress(app)).toBe(true);
      expect(queryOf(app)).toEqual({ error: 'state_mismatch', state: 'kept', iss: await issuer() });
    });
  });

  describe('a browser that fetches a step again', () => {
    it('mints nothing when the callback is fetched again (#1019)', async () => {
      const result = await appSignInThroughProvider(baseUrl, claimsOf(freshIdentity()));
      expect(codeOf(result)).toEqual(expect.any(String));

      const again = await nextLocation(baseUrl, result.callbackUrl, result.browserCookies);

      expect(again.pathname).toBe(ERROR_PAGE_PATH);
      expect(again.searchParams.get('error')).toBe('state_mismatch');
      expect(again.searchParams.has('code')).toBe(false);
    });

    it('mints nothing when the return page is fetched again after an error (#1019)', async () => {
      const returnPage = await cancelAtProvider(await startAppSignIn(baseUrl));
      expect(isAppAddress(await nextLocation(baseUrl, returnPage))).toBe(true);

      const again = await nextLocation(baseUrl, returnPage);

      expect(again.pathname).toBe(ERROR_PAGE_PATH);
      expect(queryOf(again)).toEqual({
        error: 'APP_SIGN_IN_FLOW_INVALID',
        error_description: MESSAGES.APP_SIGN_IN_FLOW_INVALID,
      });
    });
  });

  /**
   * Someone who learns a pending flow's id, as its own browser does, points a
   * web sign-in of their own at that flow's return page. Were the hand-off to
   * trust the sign-in's `callbackURL`, which a client chooses and better-auth
   * lets through as a relative path, the app waiting on the flow would be
   * signed in as them. The flow is a real pending one: a made-up id would pass
   * even against a server that trusted `callbackURL`.
   */
  it.each([
    ['a plain web sign-in', false],
    ['one that names the flow in its additionalData', true],
  ])(
    'hands nothing to a pending app sign-in from a web sign-in sent to its return page: %s (#1019)',
    async (_case, forged) => {
      const pending = await cancelAtProvider(await startAppSignIn(baseUrl, { state: 'waiting-app' }));
      const flow = pending.searchParams.get('flow') ?? '';
      expect(flow).not.toBe('');
      const intruder = freshIdentity();

      const web = await signInThroughProvider(baseUrl, claimsOf(intruder), {
        callbackURL: `${APP_SIGN_IN_RETURN_PATH}?flow=${flow}`,
        ...(forged ? { additionalData: { serverContext: { [APP_SIGN_IN_FLOW_KEY]: flow } } } : {}),
      });

      // The web sign-in completes as usual, with the address it asked for.
      expect(web.location.pathname).toBe(APP_SIGN_IN_RETURN_PATH);
      expect(web.location.searchParams.get('flow')).toBe(flow);
      await expect(sessionUserOf({ Cookie: web.cookie })).resolves.toBe(await userIdByEmail(intruder.email));

      const app = await nextLocation(baseUrl, web.location, web.cookie);

      expect(isAppAddress(app)).toBe(true);
      expect(queryOf(app)).toEqual({
        error: 'APP_SIGN_IN_FLOW_INVALID',
        error_description: MESSAGES.APP_SIGN_IN_FLOW_INVALID,
        state: 'waiting-app',
        iss: await issuer(),
      });
    },
  );

  describe('the exchange', () => {
    /** An app sign-in through the strict fake, up to the code the app receives. */
    const signedInApp = async () => {
      const identity = freshIdentity();
      const result = await appSignInThroughProvider(baseUrl, claimsOf(identity));

      return { identity, code: codeOf(result), verifier: result.verifier };
    };

    it('exchanges the code for a session of the app’s own (#1019)', async () => {
      const { identity, code, verifier } = await signedInApp();

      const exchange = await exchangeAppSignInCode(baseUrl, { code, code_verifier: verifier });

      expect(exchange.status).toBe(200);
      expect(exchange.headers.get('cache-control')).toBe('no-store');
      expect(exchange.headers.get('pragma')).toBe('no-cache');
      const body = await answerOf(exchange);
      const userId = await userIdByEmail(identity.email);
      expect(body).toEqual({ token: expect.any(String), user: expect.objectContaining({ id: userId }) });
      expect(exchange.headers.get('set-auth-token')).toEqual(expect.stringContaining(body.token));
      const session = await request(baseUrl).get(GET_SESSION_PATH).set(bearer(body.token)).expect(200);
      expect(session.body.user.id).toBe(userId);
      expect(session.body.session.userAgent).toBe(APP_USER_AGENT);
    });

    it('refuses a used code (#1019)', async () => {
      const { code, verifier } = await signedInApp();
      expect((await exchangeAppSignInCode(baseUrl, { code, code_verifier: verifier })).status).toBe(200);

      const again = await exchangeAppSignInCode(baseUrl, { code, code_verifier: verifier });

      expect(again.status).toBe(400);
      await expect(again.json()).resolves.toEqual(CODE_INVALID_BODY);
    });

    // A well-formed exchange uses the code up, whether or not the verifier
    // matches, so a weak verifier gets one guess per code.
    it('refuses a wrong verifier, and the code is gone after (#1019)', async () => {
      const { code, verifier } = await signedInApp();

      const wrong = await exchangeAppSignInCode(baseUrl, { code, code_verifier: pkcePair().verifier });
      const right = await exchangeAppSignInCode(baseUrl, { code, code_verifier: verifier });

      expect(wrong.status).toBe(400);
      await expect(wrong.json()).resolves.toEqual(CODE_INVALID_BODY);
      expect(right.status).toBe(400);
      await expect(right.json()).resolves.toEqual(CODE_INVALID_BODY);
    });

    it('refuses a made-up code (#1019)', async () => {
      const exchange = await exchangeAppSignInCode(baseUrl, {
        code: 'a-code-this-server-never-issued-',
        code_verifier: pkcePair().verifier,
      });

      expect(exchange.status).toBe(400);
      await expect(exchange.json()).resolves.toEqual(CODE_INVALID_BODY);
    });

    it('lets one of two exchanges at once succeed (#1019)', async () => {
      const { code, verifier } = await signedInApp();

      const statuses = await Promise.all(
        [1, 2].map(async () => (await exchangeAppSignInCode(baseUrl, { code, code_verifier: verifier })).status),
      );

      expect(statuses.sort()).toEqual([200, 400]);
    });

    // A request the server can't read never reaches the code, so the app can
    // send a proper one after. That holds for a body that isn't JSON at all,
    // which the route reads itself rather than leave to better-auth's parser.
    it('refuses a malformed exchange without using the code up (#1019)', async () => {
      const { code, verifier } = await signedInApp();

      const malformed = [
        () => exchangeAppSignInCode(baseUrl, { code }),
        () => exchangeAppSignInCode(baseUrl, { code: 12345, code_verifier: verifier }),
        () => exchangeAppSignInCode(baseUrl, { code, code_verifier: 'v'.repeat(129) }),
        () => postAppSignInToken(baseUrl, 'application/json', '{"code":'),
        () =>
          postAppSignInToken(baseUrl, 'application/x-www-form-urlencoded', `code=${code}&code_verifier=${verifier}`),
      ];
      for (const send of malformed) {
        const response = await send();
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual(REQUEST_INVALID_BODY);
      }

      expect((await exchangeAppSignInCode(baseUrl, { code, code_verifier: verifier })).status).toBe(200);
    });

    it('refuses a user banned after the code was issued (#1019)', async () => {
      const { identity, code, verifier } = await signedInApp();
      const userId = await userIdByEmail(identity.email);
      // The callback's own session is gone already, so the user holds none.
      await expect(apiCacheHas(`auth_active-sessions-${userId}`)).resolves.toBe(false);
      await db.client.user.update({ where: { id: userId }, data: { banned: true } });

      const exchange = await exchangeAppSignInCode(baseUrl, { code, code_verifier: verifier });

      expect(exchange.status).toBe(403);
      await expect(exchange.json()).resolves.toMatchObject({ code: 'BANNED_USER' });
      await expect(apiCacheHas(`auth_active-sessions-${userId}`)).resolves.toBe(false);
    });
  });
});
