import { isAPIError } from 'better-auth/api';
import { createIdTokenGate, SIGN_IN_PROVIDER_ID_TOKEN_REFUSED } from './id-token-gate';

/** What a refusal carries on the wire, read off the thrown `APIError`. */
function refusalOf(attempt: () => void): { status: number; code?: string; message?: string } | undefined {
  try {
    attempt();
  } catch (error) {
    if (!isAPIError(error)) {
      throw error;
    }

    const body = error.body as { code?: string; message?: string } | undefined;
    return { status: error.statusCode, code: body?.code, message: body?.message };
  }

  return undefined;
}

describe('createIdTokenGate', () => {
  const gate = createIdTokenGate((key) => `rendered:${key}`);

  // A client that submits a sign-in provider's ID token skips the redirect
  // flow's state and PKCE, which is why the server refuses it (#1016).
  it.each(['/sign-in/social', '/link-social'])(
    'refuses an ID token submitted to %s, with its code and a rendered message (#1016)',
    (path) => {
      expect(refusalOf(() => gate.beforeRoute({ path, body: { provider: 'fake', idToken: { token: 'x' } } }))).toEqual({
        status: 403,
        code: SIGN_IN_PROVIDER_ID_TOKEN_REFUSED,
        message: 'rendered:errors.auth.sign_in_provider_id_token_refused',
      });
    },
  );

  // Zod would refuse a non-object later; the gate must not depend on it, and an
  // empty value is still a submission.
  it.each([null, '', 0, false])('refuses a submitted idToken of %p as well (#1016)', (idToken) => {
    expect(refusalOf(() => gate.beforeRoute({ path: '/sign-in/social', body: { idToken } }))?.code).toBe(
      SIGN_IN_PROVIDER_ID_TOKEN_REFUSED,
    );
  });

  it.each(['/sign-in/social', '/link-social'])('lets %s through without an ID token (#1016)', (path) => {
    expect(refusalOf(() => gate.beforeRoute({ path, body: { provider: 'fake' } }))).toBeUndefined();
    expect(refusalOf(() => gate.beforeRoute({ path, body: { provider: 'fake', idToken: undefined } }))).toBeUndefined();
    expect(refusalOf(() => gate.beforeRoute({ path }))).toBeUndefined();
  });

  // Google One Tap's body is an ID token by design, and it is not a configured
  // sign-in provider's path. It signs nobody in here, as `oneTap()` has no
  // Google client id and answers every call with 400, but the gate leaves it to
  // the plugin.
  it('leaves other routes alone, One Tap included (#1016)', () => {
    expect(refusalOf(() => gate.beforeRoute({ path: '/one-tap/callback', body: { idToken: 'x' } }))).toBeUndefined();
    expect(refusalOf(() => gate.beforeRoute({ path: '/sign-in/email', body: { idToken: 'x' } }))).toBeUndefined();
    expect(refusalOf(() => gate.beforeRoute({ body: { idToken: 'x' } }))).toBeUndefined();
  });
});
