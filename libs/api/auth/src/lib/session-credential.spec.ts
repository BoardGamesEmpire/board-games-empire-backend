import { betterAuth } from 'better-auth';
import { AUTH_COOKIE_PREFIX } from './constants';
import { hasSessionCookie, isBearerAuthorization } from './session-credential';

/** The name better-auth gives the session cookie, configured with the app's prefix and served from `baseURL`. */
const sessionCookieNameFor = async (baseURL: string): Promise<string> => {
  const auth = betterAuth({
    telemetry: { enabled: false },
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    baseURL,
    advanced: { cookiePrefix: AUTH_COOKIE_PREFIX },
  });

  return (await auth.$context).authCookies.sessionToken.name;
};

describe('hasSessionCookie', () => {
  it.each([
    ['the session cookie alone', 'bge_auth_.session_token=abc.def'],
    ['the secure-prefixed session cookie', '__Secure-bge_auth_.session_token=abc.def'],
    ['the dash-separated spelling', 'bge_auth_-session_token=abc.def'],
    ['the session cookie among others', 'theme=dark; bge_auth_.session_token=abc.def; lb=2'],
  ])('finds %s', (_, cookie) => {
    expect(hasSessionCookie(cookie)).toBe(true);
  });

  // The cookie names above are hand-written. These are the ones better-auth
  // actually issues, so a change to its naming or to the prefix fails here.
  it('finds the session cookie better-auth issues over plain HTTP', async () => {
    const name = await sessionCookieNameFor('http://localhost:3000');

    expect(hasSessionCookie(`theme=dark; ${name}=token.signature`)).toBe(true);
  });

  it('finds the secure-prefixed session cookie better-auth issues over HTTPS', async () => {
    const name = await sessionCookieNameFor('https://bge.example');

    expect(name.startsWith('__Secure-')).toBe(true);
    expect(hasSessionCookie(`theme=dark; ${name}=token.signature`)).toBe(true);
  });

  it.each([
    ['no cookie', undefined],
    ['only unrelated cookies', 'theme=dark; lb=2'],
    ['a cookie whose name merely ends like the session one', 'other_bge_auth_.session_token=abc'],
  ])('finds none in %s', (_, cookie) => {
    expect(hasSessionCookie(cookie)).toBe(false);
  });
});

describe('isBearerAuthorization', () => {
  it.each(['Bearer abc.def', 'bearer abc'])('accepts %s', (authorization) => {
    expect(isBearerAuthorization(authorization)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['Basic credentials', 'Basic dXNlcjpwYXNz'],
    ['a scheme with no token', 'Bearer'],
  ])('refuses %s', (_, authorization) => {
    expect(isBearerAuthorization(authorization)).toBe(false);
  });
});
