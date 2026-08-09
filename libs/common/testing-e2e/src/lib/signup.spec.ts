import {
  extractSessionToken,
  extractUserId,
  performSignup,
  prepareSignup,
  SET_AUTH_TOKEN_HEADER,
  SIGN_UP_EMAIL_PATH,
  signupFailureMessage,
} from './signup.js';

describe('prepareSignup', () => {
  it('generates unique credentials per call', () => {
    const first = prepareSignup();
    const second = prepareSignup();

    expect(first.username).not.toBe(second.username);
    expect(first.email).not.toBe(second.email);
    expect(first.password).not.toBe(second.password);
  });

  it('maps username onto the BetterAuth name field', () => {
    const prepared = prepareSignup({ username: 'alice' });

    expect(prepared.body.name).toBe('alice');
    expect(prepared.username).toBe('alice');
  });

  it('honors explicit overrides verbatim', () => {
    const prepared = prepareSignup({ email: 'alice@e2e.invalid', password: 'S3cret!password' });

    expect(prepared.body.email).toBe('alice@e2e.invalid');
    expect(prepared.body.password).toBe('S3cret!password');
  });

  it('omits the additional name fields unless supplied', () => {
    const bare = prepareSignup();
    expect(bare.body).not.toHaveProperty('firstName');
    expect(bare.body).not.toHaveProperty('lastName');

    const named = prepareSignup({ firstName: 'Alice', lastName: 'Ng' });
    expect(named.body.firstName).toBe('Alice');
    expect(named.body.lastName).toBe('Ng');
  });
});

describe('extractSessionToken', () => {
  it('prefers the set-auth-token header over the body token', () => {
    const headers = new Headers({ [SET_AUTH_TOKEN_HEADER]: 'header-token' });

    expect(extractSessionToken(headers, { token: 'body-token' })).toBe('header-token');
  });

  it('falls back to the body token when the header is absent', () => {
    expect(extractSessionToken(new Headers(), { token: 'body-token' })).toBe('body-token');
  });

  it('fails loudly, naming the bearer plugin, when no token is present anywhere', () => {
    expect(() => extractSessionToken(new Headers(), { token: null })).toThrow(/bearer\(\) plugin/);
    expect(() => extractSessionToken(new Headers(), 'not-an-object')).toThrow(SET_AUTH_TOKEN_HEADER);
  });
});

describe('extractUserId', () => {
  it('reads user.id from the response body', () => {
    expect(extractUserId({ user: { id: 'usr_1' } })).toBe('usr_1');
  });

  it('fails loudly on a shape without user.id', () => {
    expect(() => extractUserId({ user: {} })).toThrow(/user\.id/);
    expect(() => extractUserId(undefined)).toThrow(/user\.id/);
  });

  it('fails loudly on a null user rather than throwing a TypeError', () => {
    expect(() => extractUserId({ user: null })).toThrow(/user\.id/);
    expect(() => extractUserId({ user: 'usr_1' })).toThrow(/user\.id/);
  });
});

describe('signupFailureMessage', () => {
  it('names USE_EMAIL_PASSWORD_AUTH on a 404, because the route vanishes when the method is disabled', () => {
    const message = signupFailureMessage(404, 'Not Found');

    expect(message).toContain('USE_EMAIL_PASSWORD_AUTH');
    expect(message).toContain(SIGN_UP_EMAIL_PATH);
  });

  it('carries the status and body for any other failure', () => {
    expect(signupFailureMessage(422, 'password too short')).toMatch(/422.*password too short/);
  });
});

describe('performSignup', () => {
  function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  }

  it('POSTs the prepared payload to the signup route and returns the parsed result', async () => {
    const fetchFn = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse(
          { token: 'body-token', user: { id: 'usr_1' } },
          { headers: { [SET_AUTH_TOKEN_HEADER]: 'header-token' } },
        ),
      );

    const result = await performSignup('http://127.0.0.1:4100/', { username: 'alice' }, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    // The trailing slash on the base URL must not double up.
    expect(url).toBe(`http://127.0.0.1:4100${SIGN_UP_EMAIL_PATH}`);
    expect(init?.method).toBe('POST');
    // Origin is required, not decorative: BetterAuth's origin check answers a
    // state-changing request with neither Origin nor Referer with
    // MISSING_OR_NULL_ORIGIN, and server-side fetch sends none by default.
    // It must match the base URL (trailing slash already trimmed) so the
    // harness's trusted-origins list accepts it.
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4100' });

    const sentBody: unknown = JSON.parse(String(init?.body));
    expect(sentBody).toMatchObject({ name: 'alice' });

    expect(result.userId).toBe('usr_1');
    expect(result.token).toBe('header-token');
    expect(result.username).toBe('alice');
  });

  it('translates a 404 into the disabled-config message instead of a bare status', async () => {
    const fetchFn = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('Not Found', { status: 404 }));

    await expect(performSignup('http://127.0.0.1:4100', {}, fetchFn)).rejects.toThrow(/USE_EMAIL_PASSWORD_AUTH/);
  });

  it('surfaces non-2xx responses with status and body', async () => {
    const fetchFn = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('password too short', { status: 422 }));

    await expect(performSignup('http://127.0.0.1:4100', {}, fetchFn)).rejects.toThrow(/422.*password too short/);
  });
});
