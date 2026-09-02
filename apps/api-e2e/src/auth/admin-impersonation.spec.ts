import { createActors, SET_AUTH_TOKEN_HEADER, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const IMPERSONATE_PATH = '/api/auth/admin/impersonate-user';
const LIST_USERS_PATH = '/api/auth/admin/list-users';
const SIGN_IN_PATH = '/api/auth/sign-in/email';
const GET_SESSION_PATH = '/api/auth/get-session';

/**
 * Acceptance for the impersonation block (#408).
 *
 * The role map's own denial is pinned by a unit spec on `ADMIN_PLUGIN_ROLES`.
 * This suite exists because that spec cannot see the thing that actually broke:
 * `admin()` was registered with no options at all, and a spec over the exported
 * constants passes just as happily when the options never reach the plugin.
 * Only the wire proves the map is reached — and that `adminUserIds`, which
 * short-circuits it, is unset.
 *
 * The endpoint stays mounted and `Session.impersonatedBy` stays in the schema
 * by decision: blocked, not removed.
 */
describe('better-auth admin impersonation', () => {
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

  /**
   * Sends `Origin` on every auth-route POST, matching `performSignup` — the
   * suite's other auth-route helper — so the two do not disagree about what a
   * request to `/api/auth` looks like. Centralizing this is #285.
   *
   * Not load-bearing for these particular requests, and the comment should not
   * imply otherwise: `validateOrigin` returns early unless the request carries
   * a `Cookie` or CSRF forcing applies (`api/middlewares/origin-check.mjs`),
   * and these authenticate by bearer token. `.env` also sets
   * `DISABLE_ORIGIN_CHECK=true` locally, which `apiEnvOverrides` does not pin.
   * `Origin` is sent so the request stays correct wherever the check IS armed
   * — `.env.example` ships it enabled.
   *
   * `baseUrl` is used verbatim: `apiEnvOverrides` puts exactly this value into
   * `TRUSTED_ORIGINS`, so any normalization here could only diverge from it.
   */
  const postToAuth = (path: string) => request(baseUrl).post(path).set('Origin', baseUrl);

  /**
   * Signs the actor in again and returns the new credential.
   *
   * Not optional plumbing — it is what makes this suite mean anything. The
   * session minted during signup snapshots the user row *before*
   * `UserProvisioningService` promotes the first human, so the Owner's signup
   * session reports `role: 'user'` (and `emailVerified: false`) no matter what
   * the column says. `hasPermission` reads that snapshot, so every admin route
   * denies a signup-session Owner for reasons that have nothing to do with the
   * role map — and an impersonation assertion made on it would pass even with
   * the block reverted.
   */
  const signInAgain = async (actor: SessionActor): Promise<{ readonly Authorization: string }> => {
    const response = await postToAuth(SIGN_IN_PATH).send({
      email: actor.user.email,
      password: actor.password,
    });

    const token = response.headers[SET_AUTH_TOKEN_HEADER];
    if (response.status !== 200 || !token) {
      throw new Error(`re-sign-in failed for ${actor.user.email}: ${response.status} ${JSON.stringify(response.body)}`);
    }

    return { Authorization: `Bearer ${token}` };
  };

  /** An Owner whose session actually carries the admin role. */
  const adminPrincipal = async (): Promise<{ readonly Authorization: string }> => {
    const owner = await actors.owner();

    return signInAgain(owner);
  };

  /**
   * The precondition every assertion below rests on. If a future change makes
   * the session role stale again, `hasPermission` falls back to the empty
   * `user` role, every admin route 403s for its own reasons, and the denials
   * in this file become vacuous. This test is what fails first instead.
   */
  it('gives the Owner a session that better-auth reads as the admin role', async () => {
    const headers = await adminPrincipal();

    const session = await request(baseUrl).get(GET_SESSION_PATH).set(headers);

    expect(session.status).toBe(200);
    expect(session.body?.user?.role).toBe('admin');
  });

  describe('POST /api/auth/admin/impersonate-user', () => {
    it('denies the Owner, whose session carries the only admin role in the system', async () => {
      const headers = await adminPrincipal();
      const target = await actors.user();

      const response = await postToAuth(IMPERSONATE_PATH).set(headers).send({ userId: target.user.id });

      expect(response.status).toBe(403);
      // better-auth's own permission failure — not an origin, validation or
      // stale-role rejection wearing the same status.
      expect(response.body).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS' });
    });

    it('denies an ordinary user', async () => {
      const user = await actors.user();
      const target = await actors.user();

      const response = await postToAuth(IMPERSONATE_PATH).set(user.headers).send({ userId: target.user.id });

      expect(response.status).toBe(403);
    });

    /**
     * Converges on the same gate as the other-user case — `user:['impersonate']`
     * is checked before any target-specific branch — so this asserts the
     * permission denial holds for a self-target too, not that a distinct target
     * check exists. Kept for the input, named for what it proves.
     */
    it('denies a self-target on the same permission gate', async () => {
      const owner = await actors.owner();
      const headers = await signInAgain(owner);

      const response = await postToAuth(IMPERSONATE_PATH).set(headers).send({ userId: owner.user.id });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS' });
    });

    /**
     * Deliberately asserted on the response, not on the `sessions` table. The
     * API runs with a Redis `secondaryStorage`, so better-auth keeps session
     * state there and the impersonation route writes no row this suite can
     * see — a `session.impersonatedBy IS NOT NULL` count comes back zero
     * whether the request was denied or served, which is worse than no test.
     */
    it('hands back no impersonation payload, so nothing can reach the actor seams', async () => {
      const headers = await adminPrincipal();
      const target = await actors.user();

      const response = await postToAuth(IMPERSONATE_PATH).set(headers).send({ userId: target.user.id });

      // Pinned first: without them, the payload assertions below hold for a
      // validation error, an origin rejection or a mistyped path just as well
      // as for the intended denial.
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS' });

      // On success better-auth returns `{ session, user }` for the target.
      expect(response.body).not.toHaveProperty('session');
      expect(response.body).not.toHaveProperty('user');
    });
  });

  /**
   * The block is meant to remove impersonation and nothing else. Without this,
   * a role map that accidentally granted the Owner nothing at all would satisfy
   * every assertion above.
   */
  describe('the admin capabilities that were kept', () => {
    it('still lets the Owner list users', async () => {
      const headers = await adminPrincipal();

      const response = await request(baseUrl).get(LIST_USERS_PATH).query({ limit: 1 }).set(headers);

      expect(response.status).toBe(200);
    });

    it('still denies an ordinary user the same route', async () => {
      const user = await actors.user();

      const response = await request(baseUrl).get(LIST_USERS_PATH).query({ limit: 1 }).set(user.headers);

      expect(response.status).toBe(403);
    });
  });
});
