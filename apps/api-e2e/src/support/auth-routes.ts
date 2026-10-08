import { SET_AUTH_TOKEN_HEADER, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';

const SIGN_IN_PATH = '/api/auth/sign-in/email';

/**
 * A POST to a better-auth route. It sends `Origin`, as `performSignup` does,
 * so the suite's auth-route helpers agree on what a request to `/api/auth`
 * looks like. Centralizing this with `performSignup` is #285.
 *
 * Whether better-auth's origin check applies depends on the request
 * (`api/middlewares/origin-check.mjs`): it returns early unless the request
 * carries a `Cookie` or CSRF forcing applies. `Origin` goes on every POST
 * regardless, so each stays correct with the check armed, as
 * `apiEnvOverrides` pins it.
 *
 * `baseUrl` is used verbatim: `apiEnvOverrides` puts exactly this value into
 * `TRUSTED_ORIGINS`, so any normalization here could only diverge from it.
 */
export function postToAuth(baseUrl: string, path: string): request.Test {
  return request(baseUrl).post(path).set('Origin', baseUrl);
}

/**
 * Signs the actor in again and returns the new credential.
 *
 * The session minted during signup snapshots the user row before
 * `UserProvisioningService` promotes the first human, so the Owner's signup
 * session reports `role: 'user'` (and `emailVerified: false`) whatever the
 * column says. better-auth's `hasPermission` reads that snapshot, so every
 * admin route refuses a signup-session Owner for reasons that have nothing to
 * do with the role map, and an assertion made on it can pass for the wrong
 * reason. A fresh sign-in carries the role.
 */
export async function signInAgain(baseUrl: string, actor: SessionActor): Promise<{ readonly Authorization: string }> {
  const response = await postToAuth(baseUrl, SIGN_IN_PATH).send({
    email: actor.user.email,
    password: actor.password,
  });

  const token = response.headers[SET_AUTH_TOKEN_HEADER];
  if (response.status !== 200 || !token) {
    throw new Error(`re-sign-in failed for ${actor.user.email}: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return { Authorization: `Bearer ${token}` };
}
