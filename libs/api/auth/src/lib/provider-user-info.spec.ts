import { createProviderUserInfo, PROVIDER_REQUEST_TIMEOUT_MS } from './provider-user-info';

const DISCOVERY_URL = 'https://p.example/.well-known/openid-configuration';
const USERINFO_URL = 'https://p.example/userinfo';
const PROVIDER = { id: 'p', discoveryUrl: DISCOVERY_URL };

const SUB = 'subject-1';
const OTHER_SUB = 'subject-2';
const EMAIL = 'ada@example.org';
const ACCESS_TOKEN = 'at-1';

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A token with claims and no signature. better-auth has already verified any
 * real one by the time getUserInfo runs, so the override only decodes it.
 */
const unsignedJwt = (claims: Record<string, unknown>): string => `${b64url({ alg: 'none' })}.${b64url(claims)}.`;

const discoveryDocument = (extra: Record<string, unknown> = { userinfo_endpoint: USERINFO_URL }) =>
  Response.json({ issuer: 'https://p.example', ...extra });

type Answer = () => Response | Promise<Response>;

/** A fetch that answers the provider's discovery document and its UserInfo endpoint, each as the test says. */
function providerFetch(userInfo: Answer, discovery: Answer = () => discoveryDocument()) {
  return jest.fn<Promise<Response>, Parameters<typeof fetch>>(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === DISCOVERY_URL) {
      return discovery();
    }

    if (url === USERINFO_URL) {
      return userInfo();
    }

    throw new Error(`unexpected request to ${url}`);
  });
}

/** The URLs a fetch stub was asked for, in order. */
const urlsOf = (fetch: { mock: { calls: ReadonlyArray<readonly unknown[]> } }) =>
  fetch.mock.calls.map(([input]) => String(input));

describe('createProviderUserInfo', () => {
  let logger: { warn: jest.Mock };

  beforeEach(() => {
    logger = { warn: jest.fn() };
  });

  afterEach(() => jest.restoreAllMocks());

  const tokensFor = (idTokenClaims?: Record<string, unknown>) => ({
    accessToken: ACCESS_TOKEN,
    ...(idTokenClaims === undefined ? {} : { idToken: unsignedJwt(idTokenClaims) }),
  });

  it("merges UserInfo's email_verified into an ID token that leaves it out (#993)", async () => {
    const fetch = providerFetch(() => Response.json({ sub: SUB, email: EMAIL, email_verified: true }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    const profile = await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));

    expect(profile).toMatchObject({ sub: SUB, email: EMAIL, emailVerified: true });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('asks UserInfo with the access token as a bearer credential, under a timeout (#993)', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const fetch = providerFetch(() => Response.json({ sub: SUB, email: EMAIL }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));

    const [discoveryCall, userInfoCall] = fetch.mock.calls;
    expect(String(discoveryCall[0])).toBe(DISCOVERY_URL);
    expect(discoveryCall[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(String(userInfoCall[0])).toBe(USERINFO_URL);
    expect(userInfoCall[1]?.headers).toEqual({ Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' });
    expect(userInfoCall[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout.mock.calls).toEqual([[PROVIDER_REQUEST_TIMEOUT_MS], [PROVIDER_REQUEST_TIMEOUT_MS]]);
  });

  it('answers null and warns, naming only the provider, when UserInfo answers for another subject (#993)', async () => {
    const fetch = providerFetch(() => Response.json({ sub: OTHER_SUB, email: EMAIL, email_verified: true }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    await expect(getUserInfo(tokensFor({ sub: SUB, email: EMAIL }))).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0];
    expect(message).toContain('"p"');
    for (const value of [SUB, OTHER_SUB, EMAIL]) {
      expect(message).not.toContain(value);
    }
  });

  it.each<[string, Answer]>([
    ['answers 401', () => Response.json({ error: 'invalid_token' }, { status: 401 })],
    [
      'answers a JWT as application/jwt',
      () =>
        new Response(unsignedJwt({ sub: SUB, email: EMAIL, email_verified: true }), {
          headers: { 'content-type': 'application/jwt' },
        }),
    ],
    ['answers a JSON array', () => Response.json([{ sub: SUB, email: EMAIL, email_verified: true }])],
    [
      'throws',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])("answers the ID token's claims alone when UserInfo %s (#993)", async (_case, answer) => {
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch: providerFetch(answer) });

    const profile = await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));

    expect(profile).toMatchObject({ sub: SUB, email: EMAIL, emailVerified: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('answers UserInfo alone without an ID token, as before (#993)', async () => {
    const fetch = providerFetch(() =>
      Response.json({ sub: SUB, email: EMAIL, email_verified: true, picture: 'https://p.example/a.png' }),
    );
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    const profile = await getUserInfo(tokensFor());

    expect(profile).toMatchObject({ sub: SUB, email: EMAIL, emailVerified: true, image: 'https://p.example/a.png' });
  });

  it('answers null without an ID token when UserInfo fails (#993)', async () => {
    const fetch = providerFetch(() => new Response('unavailable', { status: 500 }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    await expect(getUserInfo(tokensFor())).resolves.toBeNull();
  });

  it("reads the provider's discovery document once, for concurrent and later sign-ins (#993)", async () => {
    const fetch = providerFetch(() => Response.json({ sub: SUB, email: EMAIL }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    await Promise.all([getUserInfo(tokensFor({ sub: SUB })), getUserInfo(tokensFor({ sub: SUB }))]);
    await getUserInfo(tokensFor({ sub: SUB }));

    expect(urlsOf(fetch).filter((url) => url === DISCOVERY_URL)).toHaveLength(1);
    expect(urlsOf(fetch).filter((url) => url === USERINFO_URL)).toHaveLength(3);
  });

  it('reads the discovery document again after a failed read (#993)', async () => {
    const discovery = jest
      .fn<Response, []>()
      .mockReturnValueOnce(new Response('unavailable', { status: 503 }))
      .mockReturnValueOnce(discoveryDocument());
    const fetch = providerFetch(() => Response.json({ sub: SUB, email: EMAIL }), discovery);
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    const first = await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    expect(urlsOf(fetch)).toEqual([DISCOVERY_URL]);
    expect(first).toMatchObject({ sub: SUB, email: EMAIL });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    expect(urlsOf(fetch)).toEqual([DISCOVERY_URL, DISCOVERY_URL, USERINFO_URL]);
  });

  it('starts reading the discovery document when it is created, before any sign-in (#993)', () => {
    const fetch = providerFetch(() => Response.json({ sub: SUB }));
    createProviderUserInfo(PROVIDER, { logger, fetch });

    expect(urlsOf(fetch)).toEqual([DISCOVERY_URL]);
  });

  // A proxy can answer the discovery URL with a JSON error while the provider
  // starts. Kept, it would stop UserInfo being asked until a restart.
  it('reads the discovery document again when the answer names no issuer or authorization endpoint (#993)', async () => {
    const discovery = jest
      .fn<Response, []>()
      .mockReturnValueOnce(Response.json({ error: 'starting' }))
      .mockReturnValueOnce(discoveryDocument());
    const fetch = providerFetch(() => Response.json({ sub: SUB, email: EMAIL }), discovery);
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    expect(urlsOf(fetch)).toEqual([DISCOVERY_URL]);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    expect(urlsOf(fetch)).toEqual([DISCOVERY_URL, DISCOVERY_URL, USERINFO_URL]);
  });

  // better-auth builds a provider from a document with no issuer, checking
  // the issuer only when there is one; such a provider's UserInfo is asked too.
  it('uses and keeps a discovery document that names no issuer but its endpoints (#993)', async () => {
    const fetch = providerFetch(
      () => Response.json({ sub: SUB, email: EMAIL, email_verified: true }),
      () => Response.json({ authorization_endpoint: 'https://p.example/authorize', userinfo_endpoint: USERINFO_URL }),
    );
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    const profile = await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));

    expect(profile).toMatchObject({ emailVerified: true });
    expect(urlsOf(fetch)).toEqual([DISCOVERY_URL, USERINFO_URL, USERINFO_URL]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // A 401 for a missing scope, or a signed answer, is how the provider
  // answers on every sign-in, so it is said once until UserInfo answers again.
  it("warns once while UserInfo can't be read, and again after it has answered (#993)", async () => {
    const userInfo = jest
      .fn<Response, []>()
      .mockReturnValueOnce(Response.json({ error: 'insufficient_scope' }, { status: 401 }))
      .mockReturnValueOnce(Response.json({ error: 'insufficient_scope' }, { status: 401 }))
      .mockReturnValueOnce(Response.json({ sub: SUB, email: EMAIL }))
      .mockReturnValueOnce(Response.json({ error: 'insufficient_scope' }, { status: 401 }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch: providerFetch(userInfo) });

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { userinfo_endpoint: 'not a url' }])(
    'asks nothing more when the discovery document lists no usable userinfo_endpoint: %p (#993)',
    async (listed) => {
      const fetch = providerFetch(
        () => Response.json({ sub: SUB }),
        () => discoveryDocument(listed),
      );
      const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

      const profile = await getUserInfo(tokensFor({ sub: SUB, email: EMAIL, email_verified: true }));
      await getUserInfo(tokensFor({ sub: SUB, email: EMAIL, email_verified: true }));

      expect(profile).toMatchObject({ sub: SUB, email: EMAIL, emailVerified: true });
      expect(urlsOf(fetch)).toEqual([DISCOVERY_URL]);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("treats an ID token it can't decode as none (#993)", async () => {
    const fetch = providerFetch(() => Response.json({ sub: SUB, email: EMAIL, email_verified: true }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    const profile = await getUserInfo({ accessToken: ACCESS_TOKEN, idToken: 'not-a-jwt' });

    expect(profile).toMatchObject({ sub: SUB, email: EMAIL, emailVerified: true });
  });

  it('sets aside a UserInfo answer with no subject, and warns (#993)', async () => {
    const fetch = providerFetch(() => Response.json({ email: EMAIL, email_verified: true }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    const profile = await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));

    expect(profile).toMatchObject({ sub: SUB, email: EMAIL, emailVerified: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('"p"');
  });

  // Leaving `sub` out is how the provider answers, not a passing fault, so
  // once tells the operator, and the mismatch warning isn't buried.
  it('warns once that UserInfo carries no subject, however many sign-ins it sets aside (#993)', async () => {
    const fetch = providerFetch(() => Response.json({ email: EMAIL, email_verified: true }));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));
    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // An unread body holds its connection until the timeout aborts it.
  it.each([
    ['the discovery document', DISCOVERY_URL],
    ['UserInfo', USERINFO_URL],
  ])("lets go of %s's body when the answer isn't 2xx (#993)", async (_name, refusedUrl) => {
    let cancelled = false;
    const refused = () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      );
    const fetch = providerFetch(
      refusedUrl === USERINFO_URL ? refused : () => Response.json({ sub: SUB }),
      refusedUrl === DISCOVERY_URL ? refused : () => discoveryDocument(),
    );
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger, fetch });

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));

    expect(cancelled).toBe(true);
  });

  it('uses the global fetch when none is given (#993)', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(providerFetch(() => Response.json({ sub: SUB, email: EMAIL })));
    const getUserInfo = createProviderUserInfo(PROVIDER, { logger });

    await getUserInfo(tokensFor({ sub: SUB, email: EMAIL }));

    expect(urlsOf(fetch)).toContain(DISCOVERY_URL);
  });
});
