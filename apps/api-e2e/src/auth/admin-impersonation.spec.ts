import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { postToAuth, signInAgain } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const IMPERSONATE_PATH = '/api/auth/admin/impersonate-user';
const LIST_USERS_PATH = '/api/auth/admin/list-users';
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
   * An Owner whose session actually carries the admin role. Not optional
   * plumbing: on the signup session every admin route refuses for its own
   * reasons (see `signInAgain`), and the denials below would pass with the
   * block reverted.
   */
  const adminPrincipal = async (): Promise<{ readonly Authorization: string }> => {
    const owner = await actors.owner();

    return signInAgain(baseUrl, owner);
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

      const response = await postToAuth(baseUrl, IMPERSONATE_PATH).set(headers).send({ userId: target.user.id });

      expect(response.status).toBe(403);
      // better-auth's own permission failure — not an origin, validation or
      // stale-role rejection wearing the same status.
      expect(response.body).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS' });
    });

    it('denies an ordinary user', async () => {
      const user = await actors.user();
      const target = await actors.user();

      const response = await postToAuth(baseUrl, IMPERSONATE_PATH).set(user.headers).send({ userId: target.user.id });

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
      const headers = await signInAgain(baseUrl, owner);

      const response = await postToAuth(baseUrl, IMPERSONATE_PATH).set(headers).send({ userId: owner.user.id });

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

      const response = await postToAuth(baseUrl, IMPERSONATE_PATH).set(headers).send({ userId: target.user.id });

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
