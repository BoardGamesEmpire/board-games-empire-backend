import { AuthType, ResourceType, Upstream } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import type { Response } from 'supertest';
import request from 'supertest';
import { mintApiKey } from '../support/api-key';
import { postToAuth } from '../support/auth-routes';
import { API_CONFIGURED_SERVER_NAME, requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { sessionCookieOf } from '../support/sign-in-provider';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

/**
 * Linking a Steam account through Steam sign-in, on the wire (#935): the
 * start, and every way the return refuses before it would ask Steam.
 *
 * A link that succeeds needs Steam itself to vouch for its answer, so the
 * unit specs cover verification against the real `openid` library and a
 * fake Steam; here, each return is refused before any request leaves the
 * server.
 *
 * The browser comes back from Steam with its session cookie, the return's
 * only credential in production. The forged-answer control and the
 * return in another user's session sends a cookie from an email-and-password sign-in,
 * and nothing else; the other returns send the session as a bearer token,
 * which the api resolves to the same signed-in user. Redis is not swept
 * between tests, but every pending sign-in belongs to a user minted for its
 * test.
 */
describe('linking a Steam account (#935)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const LIST = '/api/users/me/upstream-accounts';
  const START = `${LIST}/steam/sign-in`;
  const RETURN = `${LIST}/steam/return`;

  /** A client page at a trusted origin, with a query of its own that the result is added beside. */
  const RETURN_TO = `https://${API_CONFIGURED_SERVER_NAME}/settings/upstream-accounts?tab=linked`;

  const STEAM_ENDPOINT = 'https://steamcommunity.com/openid/login';
  const OPENID_2_NAMESPACE = 'http://specs.openid.net/auth/2.0';
  const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
  const STEAM_CLAIMED_ID = 'https://steamcommunity.com/openid/id/76561197960287930';

  const THIRTY_MINUTES_MS = 30 * 60 * 1000;

  /** Well under the 10 seconds the server waits for Steam: a refusal this fast asked no one. */
  const REFUSED_WITHOUT_ASKING_MS = 5_000;

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  let seq = 0;

  /** A remote DataGateway declaring Steam, which makes Steam linkable. Nothing connects to it. */
  const seedSteamDataGateway = () =>
    db.client.dataGateway.create({
      data: {
        name: `Steam Gateway ${++seq}`,
        upstream: Upstream.Steam,
        enabled: true,
        connectionUrl: 'localhost',
        connectionPort: 50099,
        authType: AuthType.None,
      },
    });

  const start = (headers: Readonly<Record<string, string>>, returnTo: string = RETURN_TO) =>
    request(baseUrl).post(START).set(headers).send({ returnTo });

  /** Starts a sign-in as `user`, and reads the state off the return address it sends Steam. */
  const startSignIn = async (user: SessionActor) => {
    const response = await start(user.headers).expect(201);
    const steam = new URL(response.body.signIn.url);
    const returnUrl = steam.searchParams.get('openid.return_to') ?? '';
    const state = new URL(returnUrl).searchParams.get('state') ?? '';

    return { response, steam, returnUrl, state };
  };

  /** Steam's return to this server, with `state` and the answer's fields, sending `headers` (none: signed out). */
  const returnFromSteam = (
    state: string,
    fields: Record<string, string>,
    headers: Readonly<Record<string, string>> = {},
  ) =>
    request(baseUrl)
      .get(RETURN)
      .query({ state, ...fields })
      .set(headers);

  /**
   * `user`'s session as a browser sends it: the cookie an email-and-password
   * sign-in sets, as the only credential.
   */
  const browserSessionOf = async (user: SessionActor): Promise<{ Cookie: string }> => {
    const signIn = await postToAuth(baseUrl, '/api/auth/sign-in/email')
      .send({ email: user.user.email, password: user.password })
      .expect(200);
    const cookie = sessionCookieOf(signIn.headers['set-cookie']);
    expect(cookie).not.toBe('');

    return { Cookie: cookie };
  };

  /** Asserts the return sent the browser on to `RETURN_TO`, its query kept, with `outcome` added. */
  const expectSentBack = (response: Response, outcome: Record<string, string>) => {
    expect(response.status).toBe(302);
    expect(response.headers['cache-control']).toBe('no-store');

    const location = new URL(response.headers['location'] ?? '');
    const expected = new URL(RETURN_TO);

    expect(`${location.origin}${location.pathname}`).toBe(`${expected.origin}${expected.pathname}`);
    expect(Object.fromEntries(location.searchParams)).toEqual({ tab: 'linked', upstreamAccount: 'steam', ...outcome });
  };

  /** Asserts the return answered 400 with nowhere to send the browser. */
  const expectExpired = (response: Response) => {
    expectErrorEnvelope(response, { status: 400, code: 'UPSTREAM_LINK_EXPIRED' });
    expect(response.headers['location']).toBeUndefined();
  };

  const CANCELLED = { 'openid.ns': OPENID_2_NAMESPACE, 'openid.mode': 'cancel' } as const;

  /**
   * A positive answer in Steam's shape, signed over every field it must sign,
   * naming another OpenID server as the one that vouches for it.
   */
  const forgedAnswer = (returnUrl: string): Record<string, string> => ({
    'openid.ns': OPENID_2_NAMESPACE,
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'http://127.0.0.1:1/openid/login',
    'openid.claimed_id': STEAM_CLAIMED_ID,
    'openid.identity': STEAM_CLAIMED_ID,
    'openid.return_to': returnUrl,
    'openid.response_nonce': `${new Date().toISOString().slice(0, 19)}Zforged`,
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'Zm9yZ2Vk',
  });

  const steamAccounts = () => db.client.upstreamAccount.count({ where: { upstream: Upstream.Steam } });

  describe('the start', () => {
    it('starts a sign-in with Steam’s address, this server as realm and return, and the policy date (#935)', async () => {
      await seedSteamDataGateway();
      const user = await actors.user();
      const policy = await request(baseUrl).get('/api/privacy-policy').expect(200);
      const origin = new URL(baseUrl).origin;

      const before = Date.now();
      const { response, steam, returnUrl, state } = await startSignIn(user);
      const after = Date.now();

      expect(response.headers['cache-control']).toBe('no-store');
      expect(`${steam.origin}${steam.pathname}`).toBe(STEAM_ENDPOINT);
      expect(Object.fromEntries(steam.searchParams)).toEqual({
        'openid.ns': OPENID_2_NAMESPACE,
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnUrl,
        'openid.realm': origin,
        'openid.identity': IDENTIFIER_SELECT,
        'openid.claimed_id': IDENTIFIER_SELECT,
      });
      // The return comes to this server, read from its own configured
      // address, with the single-use state as the only thing in its query.
      expect(returnUrl).toBe(`${origin}${RETURN}?state=${state}`);
      expect(state).toMatch(/^[\w-]{32}$/);

      const expiresAt = Date.parse(response.body.signIn.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + THIRTY_MINUTES_MS - 1_000);
      expect(expiresAt).toBeLessThanOrEqual(after + THIRTY_MINUTES_MS + 1_000);

      // The policy to show before sending the browser to Steam: the one
      // `GET /api/privacy-policy` serves, dated as it dates it (#934).
      expect(response.body.signIn.privacyPolicy).toEqual({
        url: '/api/privacy-policy',
        language: policy.body.privacyPolicy.language,
        updatedAt: policy.body.privacyPolicy.updatedAt,
      });
    });

    it('refuses an untrusted return address, an API key, and a server with no Steam DataGateway (#935)', async () => {
      const user = await actors.user();

      // No DataGateway declares Steam yet.
      expectErrorEnvelope(await start(user.headers), { status: 409, code: 'UPSTREAM_NOT_LINKABLE' });

      await seedSteamDataGateway();

      for (const returnTo of [
        'https://untrusted.example/settings',
        '/settings/upstream-accounts',
        `ftp://${API_CONFIGURED_SERVER_NAME}/settings`,
      ]) {
        expectErrorEnvelope(await start(user.headers, returnTo), {
          status: 400,
          code: 'UPSTREAM_LINK_RETURN_ADDRESS_REFUSED',
        });
      }

      // An API key acts for its owner but is not the owner's browser
      // session. This one holds the grants to read and link the owner's
      // upstream accounts; the list answering it shows the key works and
      // carries the read grant, not that the create grant would pass the
      // permission check, since no route takes a key's create on upstream
      // accounts. That the 403 is the start's own refusal of a key, past the
      // permission check, is pinned by the controller's unit spec.
      const key = await mintApiKey(baseUrl, db.client, user, {
        resourceType: ResourceType.UpstreamAccount,
        slugs: ['create:upstream_account:own', 'read:upstream_account:own'],
      });
      await request(baseUrl).get(LIST).set(key.headers).expect(200);
      await start(key.headers).expect(403);

      // An anonymous user holds no upstream_account permission, so the
      // permission check answers 403 before the start is reached; someone
      // not signed in gets 401.
      const anonymous = await actors.anonymous();
      await start(anonymous.headers).expect(403);
      expectErrorEnvelope(await start({}), { status: 401, code: 'UNAUTHORIZED' });

      // The control: the same user's own session starts one.
      await start(user.headers).expect(201);
    });

    it('answers UPSTREAM_ACCOUNT_ALREADY_LINKED to a user who has a Steam account (#935)', async () => {
      await seedSteamDataGateway();
      const user = await actors.user();
      await db.client.upstreamAccount.create({
        data: { userId: user.user.id, upstream: Upstream.Steam, externalId: '76561197960287930', verified: true },
      });

      expectErrorEnvelope(await start(user.headers), { status: 409, code: 'UPSTREAM_ACCOUNT_ALREADY_LINKED' });

      // The control: once it is unlinked, the start goes ahead.
      await request(baseUrl).delete(`${LIST}/steam`).set(user.headers).expect(200);
      await start(user.headers).expect(201);
    });
  });

  describe('the return', () => {
    it('answers UPSTREAM_LINK_EXPIRED for an unknown state, without redirecting (#935)', async () => {
      const user = await actors.user();

      // Of a state's form, but never issued; then malformed; then missing.
      expectExpired(await returnFromSteam('a'.repeat(32), CANCELLED, user.headers));
      expectExpired(await returnFromSteam('not-a-state', CANCELLED, user.headers));
      expectExpired(await request(baseUrl).get(RETURN).query(CANCELLED).set(user.headers));
    });

    it('answers UPSTREAM_LINK_EXPIRED for a repeated state, which is not a single string (#935)', async () => {
      await seedSteamDataGateway();
      const user = await actors.user();
      const { state } = await startSignIn(user);

      expectExpired(await request(baseUrl).get(`${RETURN}?state=${state}&state=${state}`).set(user.headers));
    });

    it('sends a return in another user’s session back with UPSTREAM_LINK_SESSION_MISMATCH, using the state up (#935)', async () => {
      await seedSteamDataGateway();
      const [user, intruder] = await Promise.all([actors.user(), actors.user()]);
      const { state, returnUrl } = await startSignIn(user);

      // The intruder's browser, with its own session cookie.
      expectSentBack(await returnFromSteam(state, forgedAnswer(returnUrl), await browserSessionOf(intruder)), {
        error: 'UPSTREAM_LINK_SESSION_MISMATCH',
      });

      // The refused arrival ended the sign-in: the user who started it can't
      // finish it now.
      expectExpired(await returnFromSteam(state, forgedAnswer(returnUrl), user.headers));
      await expect(steamAccounts()).resolves.toBe(0);
    });

    it('sends a return with no session back with UPSTREAM_LINK_SESSION_MISMATCH, using the state up (#935)', async () => {
      await seedSteamDataGateway();
      const user = await actors.user();
      const { state, returnUrl } = await startSignIn(user);

      // Signed out: the route takes no session, so the global guards let the
      // return through to the session check, which sends the browser back.
      expectSentBack(await returnFromSteam(state, forgedAnswer(returnUrl)), {
        error: 'UPSTREAM_LINK_SESSION_MISMATCH',
      });

      expectExpired(await returnFromSteam(state, forgedAnswer(returnUrl), user.headers));
      await expect(steamAccounts()).resolves.toBe(0);
    });

    // The bearer case: a session sent as a bearer token reaches the answer
    // as the cookie does.
    it('sends a cancelled sign-in back with UPSTREAM_LINK_CANCELLED (#935)', async () => {
      await seedSteamDataGateway();
      const user = await actors.user();
      const { state } = await startSignIn(user);

      expectSentBack(await returnFromSteam(state, CANCELLED, user.headers), { error: 'UPSTREAM_LINK_CANCELLED' });
      await expect(steamAccounts()).resolves.toBe(0);
    });

    // The positive control for the session checks above: the same answer, in
    // the session of the user who started, gets past the session check to the
    // verifier, which refuses it before asking anyone, since it names a server
    // other than Steam's. So the two mismatch tests' refusals come from the
    // session check, not from the answer. The session is the browser's
    // cookie alone, as Steam's redirect brings it, so reaching the verifier
    // also shows the cookie resolves to the user who started.
    it('refuses a forged answer naming another OpenID server (#935)', async () => {
      await seedSteamDataGateway();
      const user = await actors.user();
      const { state, returnUrl } = await startSignIn(user);
      const browser = await browserSessionOf(user);

      const began = Date.now();
      const response = await returnFromSteam(state, forgedAnswer(returnUrl), browser);

      expect(Date.now() - began).toBeLessThan(REFUSED_WITHOUT_ASKING_MS);
      expectSentBack(response, { error: 'UPSTREAM_LINK_NOT_VERIFIED' });
      await expect(steamAccounts()).resolves.toBe(0);
    });

    // Starting again replaces the pending sign-in in Redis, and the return
    // uses its state up there, so this runs both against a real server (and
    // the redis-compat matrix's servers).
    it('replaces the first sign-in when the user starts a second (#935)', async () => {
      await seedSteamDataGateway();
      const user = await actors.user();
      const first = await startSignIn(user);
      const second = await startSignIn(user);

      expect(second.state).not.toBe(first.state);
      expectExpired(await returnFromSteam(first.state, CANCELLED, user.headers));

      // The second still reaches the session check and Steam's answer.
      expectSentBack(await returnFromSteam(second.state, CANCELLED, user.headers), {
        error: 'UPSTREAM_LINK_CANCELLED',
      });
    });
  });
});
