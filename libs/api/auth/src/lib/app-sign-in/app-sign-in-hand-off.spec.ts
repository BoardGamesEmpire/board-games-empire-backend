import { APP_SIGN_IN_FLOW_INVALID } from './app-sign-in-codes';
import { APP_SIGN_IN_FLOW_KEY, handOffAppSignIn, type AppSignInHandOff } from './app-sign-in-hand-off';
import { createAppSignInStore, type AppSignInStore } from './app-sign-in-store';
import { memoryVerificationStore } from './verification-store.fixture';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ISSUER = 'https://bge.example';
const CREDENTIAL_COOKIES = ['bge.session_token', 'bge.session_data', 'bge.dont_remember', 'bge.account_data'];
const CREATED = { session: { token: 'callback-session-token' }, user: { id: 'user-b' } };

/**
 * The callback's response headers, with a bearer token as a hook before this
 * one could add, so the strip is shown to take it too.
 */
function callbackHeaders(): Headers {
  const headers = new Headers({
    location: '/api/auth/app-sign-in/return?flow=whatever',
    'set-auth-token': 'callback-session-token.signature',
    'access-control-expose-headers': 'set-auth-token',
  });
  headers.append('set-cookie', 'bge.state=; Max-Age=0; Path=/');
  headers.append('set-cookie', 'bge.session_token=callback-session-token.signature; Max-Age=604800; Path=/; HttpOnly');

  return headers;
}

async function setUp(overrides: { store?: (store: AppSignInStore) => AppSignInStore } = {}) {
  const { store: verifications, records } = memoryVerificationStore();
  const store = createAppSignInStore(verifications);
  const flowId = await store.openFlow({
    returnAddress: new URL('bge://oauth/server-7'),
    codeChallenge: CHALLENGE,
    state: 'a&b',
  });
  const deleteSession = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
  const forgetNewSession = jest.fn<void, []>();
  const logger = { error: jest.fn() };
  const headers = callbackHeaders();

  const handOff = (input: Partial<AppSignInHandOff> = {}) =>
    handOffAppSignIn({
      oauthState: {
        callbackURL: '/api/auth/app-sign-in/return?flow=' + flowId,
        serverContext: { [APP_SIGN_IN_FLOW_KEY]: flowId },
      },
      created: CREATED,
      callbackLocation: '/api/auth/app-sign-in/return?flow=' + flowId,
      responseHeaders: headers,
      forgetNewSession,
      credentialCookies: CREDENTIAL_COOKIES,
      store: overrides.store?.(store) ?? store,
      deleteSession,
      logger,
      issuer: ISSUER,
      errorPage: (code) => `${ISSUER}/api/auth/error?error=${code}`,
      ...input,
    });

  return { store, records, flowId, deleteSession, forgetNewSession, logger, headers, handOff };
}

describe('handOffAppSignIn', () => {
  // The callback's session goes to the app, through a code, and never to the
  // browser: the browser is sent straight to the app (#1019).
  it('sends the browser to the app with a code, the app’s state and the issuer (#1019)', async () => {
    const { store, handOff } = await setUp();

    const target = await handOff();

    const url = new URL(target as string);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('bge://oauth/server-7');
    expect([...url.searchParams.keys()]).toEqual(['code', 'state', 'iss']);
    expect(url.searchParams.get('state')).toBe('a&b');
    expect(url.searchParams.get('iss')).toBe(ISSUER);
    await expect(store.redeemCode(url.searchParams.get('code') as string)).resolves.toEqual({
      userId: 'user-b',
      codeChallenge: CHALLENGE,
    });
  });

  it('strips the session credentials, deletes the callback’s session and uses the flow up (#1019)', async () => {
    const { store, flowId, deleteSession, headers, handOff } = await setUp();

    await handOff();

    expect(headers.getSetCookie()).toEqual(['bge.state=; Max-Age=0; Path=/']);
    expect(headers.has('set-auth-token')).toBe(false);
    expect(deleteSession).toHaveBeenCalledWith('callback-session-token');
    await expect(store.takeFlow(flowId)).resolves.toBeNull();
  });

  // The hooks after this one react to a new session: the anonymous plugin
  // would delete the browser's guest as upgraded, and the last-login-method
  // plugin would set its cookie. Forgetting it, with the credentials gone,
  // leaves them nothing to react to.
  it('tells the hooks after it that the callback created no session (#1019)', async () => {
    const { forgetNewSession, handOff } = await setUp();

    await handOff();

    expect(forgetNewSession).toHaveBeenCalledTimes(1);
  });

  // A hook before this one, or the callback, refused the sign-in after the
  // session was created: the refusal stands, and the app gets no code. The
  // flow stays for a refusal that sends the browser to the return page.
  it.each([
    ['an error response', undefined],
    ['a redirect elsewhere', '/api/auth/error?error=REFUSED'],
    ['the return page with an error', '/api/auth/app-sign-in/return?flow=FLOW&error=REFUSED'],
  ])('mints nothing, and leaves no session, when the sign-in was refused with %s (#1019)', async (_case, location) => {
    const { store, flowId, records, deleteSession, forgetNewSession, headers, handOff } = await setUp();
    const recordsBefore = records.size;

    await expect(handOff({ callbackLocation: location?.replace('FLOW', flowId) })).resolves.toBeUndefined();

    expect(records.size).toBe(recordsBefore);
    expect(headers.getSetCookie()).toEqual(['bge.state=; Max-Age=0; Path=/']);
    expect(headers.has('set-auth-token')).toBe(false);
    expect(forgetNewSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith('callback-session-token');
    await expect(store.takeFlow(flowId)).resolves.not.toBeNull();
  });

  // The flow's id rides better-auth's server context, which a client can't
  // write. `callbackURL` is the client's to choose, and a relative path passes
  // better-auth's origin check, so it never identifies a flow.
  it.each([
    ['no OAuth state', null],
    ['a server context without the flow', 'empty'],
    ['a flow id that isn’t a string', 'number'],
  ] as const)('changes nothing for %s, even when callbackURL names the return page (#1019)', async (_case, kind) => {
    const { store, flowId, deleteSession, forgetNewSession, headers, handOff } = await setUp();
    const before = [...headers.entries()];
    const callbackURL = '/api/auth/app-sign-in/return?flow=' + flowId;
    const oauthState =
      kind === null ? null : { callbackURL, serverContext: kind === 'empty' ? {} : { [APP_SIGN_IN_FLOW_KEY]: 7 } };

    await expect(handOff({ oauthState })).resolves.toBeUndefined();

    expect([...headers.entries()]).toEqual(before);
    expect(forgetNewSession).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    await expect(store.takeFlow(flowId)).resolves.not.toBeNull();
  });

  // An error redirect creates no session; the return page carries it to the app.
  it('changes nothing when the callback created no session (#1019)', async () => {
    const { store, flowId, deleteSession, headers, handOff } = await setUp();
    const before = [...headers.entries()];

    await expect(handOff({ created: null })).resolves.toBeUndefined();

    expect([...headers.entries()]).toEqual(before);
    expect(deleteSession).not.toHaveBeenCalled();
    await expect(store.takeFlow(flowId)).resolves.not.toBeNull();
  });

  it('sends the browser to the error page, and mints nothing, when the flow is gone (#1019)', async () => {
    const { store, flowId, records, deleteSession, headers, handOff } = await setUp();
    await store.takeFlow(flowId);

    await expect(handOff()).resolves.toBe(`${ISSUER}/api/auth/error?error=${APP_SIGN_IN_FLOW_INVALID}`);

    expect(records.size).toBe(0);
    expect(headers.getSetCookie()).toEqual(['bge.state=; Max-Age=0; Path=/']);
    expect(deleteSession).toHaveBeenCalledWith('callback-session-token');
  });

  // The storage failing between the callback and the code: the request fails,
  // and still no credential reaches the browser and the session is gone. An
  // end-to-end test can't make Redis fail at that moment.
  it('leaves no credential and no session behind when the code can’t be stored (#1019)', async () => {
    const failure = new Error('the verification store is unreachable');
    const { deleteSession, headers, handOff } = await setUp({
      store: (store) => ({ ...store, issueCode: () => Promise.reject(failure) }),
    });

    await expect(handOff()).rejects.toBe(failure);

    expect(headers.getSetCookie()).toEqual(['bge.state=; Max-Age=0; Path=/']);
    expect(headers.has('set-auth-token')).toBe(false);
    expect(deleteSession).toHaveBeenCalledWith('callback-session-token');
  });

  // Deleting the session is best effort: its failure is logged, and neither
  // replaces the request's own outcome nor stops the app getting its code.
  it('logs a session it couldn’t delete, and still hands the code over (#1019)', async () => {
    const { deleteSession, logger, handOff } = await setUp();
    deleteSession.mockRejectedValue(new Error('the session store is unreachable'));

    const target = await handOff();

    expect(new URL(target as string).searchParams.get('code')).toEqual(expect.any(String));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('keeps the storage failure, not the delete failure, when both fail (#1019)', async () => {
    const failure = new Error('the verification store is unreachable');
    const { deleteSession, logger, handOff } = await setUp({
      store: (store) => ({ ...store, issueCode: () => Promise.reject(failure) }),
    });
    deleteSession.mockRejectedValue(new Error('the session store is unreachable'));

    await expect(handOff()).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
