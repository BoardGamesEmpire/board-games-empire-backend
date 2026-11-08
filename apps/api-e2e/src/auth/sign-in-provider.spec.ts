import { ProviderLinkingPolicy } from '@bge/database';
import { createActors, pollUntil, type Actors } from '@bge/testing-e2e';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { postToAuth } from '../support/auth-routes';
import {
  FAKE_PROVIDER_ID,
  fakeProviderEnv,
  LENIENT_FAKE_PROVIDER_ID,
  requireBaseUrl,
  SIGNED_FAKE_PROVIDER_ID,
} from '../support/e2e-env';
import { base64UrlJson } from '../support/fake-sign-in-provider';
import { useProviderLinkingPolicy } from '../support/provider-linking-policy';
import { ageStoredSession } from '../support/session-age';
import { useSettingSwitch } from '../support/setting-switch';
import { fakeProviderUrl, sessionCookieOf, signInThroughProvider } from '../support/sign-in-provider';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const GET_SESSION_PATH = '/api/auth/get-session';
const SIGN_OUT_PATH = '/api/auth/sign-out';
const DISCOVERY_PATH = '/.well-known/bge-identity';
const SIGNED_DISCOVERY_PATH = '/signed/.well-known/openid-configuration';

/** What the server answers a submitted ID token with (#1016). */
const ID_TOKEN_REFUSED_BODY = {
  code: 'SIGN_IN_PROVIDER_ID_TOKEN_REFUSED',
  message:
    "This server doesn't accept a sign-in provider's token sent directly. Sign in through the provider's page instead",
} as const;

/**
 * What the provider linking gate tells a client whose provider sign-in would
 * link a registered user's email while only a signed-in user may link (#913).
 */
const LINK_NEEDS_SIGN_IN_DESCRIPTION =
  'That email address already belongs to a user on this server. Sign in another way, then link this sign-in provider from your sign-in methods';

/** What the gate tells a client whose provider didn't confirm the email it would link automatically (#913). */
const LINK_EMAIL_UNVERIFIED_DESCRIPTION =
  "Your sign-in provider hasn't confirmed your email address, so the provider can't be linked automatically. Sign in another way, then link the provider from your sign-in methods";

/** A token with claims and no signature, as a client that forged one would send it. */
const unsignedIdToken = (claims: Record<string, unknown>): string =>
  `${base64UrlJson({ alg: 'none', typ: 'JWT' })}.${base64UrlJson(claims)}.`;

/**
 * An ID token the signed fake provider signs with the key it publishes, for the
 * claims given. Nothing about it is wrong: its issuer is the one the provider's
 * discovery document names, its audience the client id the API holds for the
 * provider, and it has not expired.
 */
const signedIdToken = async (claims: Record<string, unknown>): Promise<string> => {
  const discovery = await request(fakeProviderUrl()).get(SIGNED_DISCOVERY_PATH).expect(200);
  const issuedAt = Math.floor(Date.now() / 1000);

  const minted = await request(fakeProviderUrl())
    .post('/id-tokens')
    .send({
      iss: discovery.body.issuer,
      aud: fakeProviderEnv(fakeProviderUrl()).OIDC_FAKE_SIGNED_CLIENT_ID,
      iat: issuedAt,
      exp: issuedAt + 600,
      ...claims,
    })
    .expect(201);

  return minted.body.idToken;
};

/**
 * Signing in through a sign-in provider (#912), end to end: the API talks to
 * the fake provider `global-setup` started, and each test sets the claims the
 * provider returns.
 */
describe('signing in through a sign-in provider', () => {
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

  /** A provider subject no other test uses, with an email and a username of its own. */
  const freshIdentity = () => {
    const unique = randomUUID().replaceAll('-', '').slice(0, 12);

    return { sub: randomUUID(), email: `e2e-provider-${unique}@e2e.invalid`, username: `e2e-provider-${unique}` };
  };

  const userByEmail = (email: string) =>
    db.client.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, username: true, firstName: true, lastName: true, emailVerified: true },
    });

  /**
   * The user's notifications, once there is one. The listener writes it after
   * the callback has answered, so a read straight away can come too early.
   */
  const notificationsOf = (userId: string) =>
    pollUntil(
      async () => {
        const rows = await db.client.notification.findMany({
          where: { userId },
          select: { type: true, payload: true },
          orderBy: { createdAt: 'asc' },
        });

        return rows.length > 0 ? rows : undefined;
      },
      { description: `a notification for user ${userId}` },
    );

  /** What the fake provider recorded of one sign-in, read back by its ticket. */
  const ticketOf = async (ticket: string) => {
    const response = await request(fakeProviderUrl()).get(`/tickets/${ticket}`).expect(200);

    return response.body;
  };

  /** How many Account rows link one provider's user, by the provider and the user's id there. */
  const accountRowCount = (providerId: string, accountId: string) =>
    db.client.account.count({ where: { providerId, accountId } });

  /** The user a credential, such as an actor's bearer token, signs in as, if it still does. */
  const sessionUserOf = async (headers: Record<string, string>): Promise<string | undefined> => {
    const response = await request(baseUrl).get(GET_SESSION_PATH).set(headers).expect(200);

    return response.body?.user?.id;
  };

  /** The user a session cookie signs in as, read the way a client reads it. */
  const sessionUserId = (cookie: string): Promise<string | undefined> => sessionUserOf({ Cookie: cookie });

  /**
   * Discovery goes out through a snake_case interceptor, so these are the keys
   * a client reads, not the DTO's camelCase ones. The client id and secret are
   * the ones the API booted with.
   */
  it('lists each sign-in provider in discovery under its label, without its client id or secret (#912)', async () => {
    const providerEnv = fakeProviderEnv(fakeProviderUrl());

    const response = await request(baseUrl).get(DISCOVERY_PATH).expect(200);

    const oidcStrategies = response.body.strategies.filter((strategy: { type: string }) => strategy.type === 'oidc');
    expect(oidcStrategies).toEqual([
      {
        type: 'oidc',
        provider_id: FAKE_PROVIDER_ID,
        display_name: 'Fake provider',
        discovery_url: providerEnv.OIDC_FAKE_DISCOVERY_URL,
        authorization_endpoint: '/api/auth/sign-in/social',
        app_sign_in_endpoint: '/api/auth/app-sign-in/start',
        app_token_endpoint: '/api/auth/app-sign-in/token',
        sign_up_disabled: false,
      },
      {
        type: 'oidc',
        provider_id: LENIENT_FAKE_PROVIDER_ID,
        display_name: 'Lenient fake provider',
        discovery_url: providerEnv.OIDC_FAKE_LENIENT_DISCOVERY_URL,
        authorization_endpoint: '/api/auth/sign-in/social',
        app_sign_in_endpoint: '/api/auth/app-sign-in/start',
        app_token_endpoint: '/api/auth/app-sign-in/token',
        sign_up_disabled: false,
      },
      {
        type: 'oidc',
        provider_id: SIGNED_FAKE_PROVIDER_ID,
        display_name: 'Signed fake provider',
        discovery_url: providerEnv.OIDC_FAKE_SIGNED_DISCOVERY_URL,
        authorization_endpoint: '/api/auth/sign-in/social',
        app_sign_in_endpoint: '/api/auth/app-sign-in/start',
        app_token_endpoint: '/api/auth/app-sign-in/token',
        sign_up_disabled: false,
      },
    ]);
    for (const secret of [
      providerEnv.OIDC_FAKE_CLIENT_ID,
      providerEnv.OIDC_FAKE_CLIENT_SECRET,
      providerEnv.OIDC_FAKE_LENIENT_CLIENT_ID,
      providerEnv.OIDC_FAKE_LENIENT_CLIENT_SECRET,
      providerEnv.OIDC_FAKE_SIGNED_CLIENT_ID,
      providerEnv.OIDC_FAKE_SIGNED_CLIENT_SECRET,
    ]) {
      expect(response.text).not.toContain(secret);
    }
  });

  describe('discovery and the provider linking policy (#913)', () => {
    const setPolicy = useProviderLinkingPolicy(() => db);

    it('reports the provider linking policy in discovery, as the settings row holds it (#913)', async () => {
      const read = async () =>
        (await request(baseUrl).get(DISCOVERY_PATH).expect(200)).body.bge_provider_linking_policy;

      expect(await read()).toBe(ProviderLinkingPolicy.SignedIn);

      await setPolicy(ProviderLinkingPolicy.AutomaticWhenVerified);
      expect(await read()).toBe(ProviderLinkingPolicy.AutomaticWhenVerified);
    });
  });

  it('asks the provider for openid, profile and email (#912)', async () => {
    const { sub, email } = freshIdentity();

    const { ticket } = await signInThroughProvider(baseUrl, { sub, email, email_verified: true });

    const recorded = await ticketOf(ticket);
    expect(recorded.scope.split(' ')).toEqual(['openid', 'profile', 'email']);
  });

  // PKCE ties the authorization code to the request that asked for it: a code
  // copied from the redirect is useless without the verifier only the API holds.
  it('sends PKCE with S256, and the verifier matches the challenge (#1016)', async () => {
    const { sub, email } = freshIdentity();

    const { ticket } = await signInThroughProvider(baseUrl, { sub, email, email_verified: true });

    const recorded = await ticketOf(ticket);
    expect(recorded.codeChallengeMethod).toBe('S256');
    expect(recorded.codeVerifier).toEqual(expect.any(String));
    // RFC 7636 asks for a verifier of 43 to 128 characters.
    expect(recorded.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(recorded.codeChallenge).toBe(createHash('sha256').update(recorded.codeVerifier).digest('base64url'));
  });

  it('creates a registered user from the provider’s claims on a first sign-in (#912)', async () => {
    const { sub, email, username } = freshIdentity();

    const result = await signInThroughProvider(baseUrl, {
      sub,
      email,
      email_verified: true,
      preferred_username: username,
      given_name: 'Ada',
      family_name: 'Lovelace',
    });

    expect(result.location.href).toBe(new URL('/', baseUrl).href);
    const created = await userByEmail(email);
    expect(created).toMatchObject({ username, firstName: 'Ada', lastName: 'Lovelace', emailVerified: true });
    await expect(sessionUserId(result.cookie)).resolves.toBe(created.id);
  });

  // A provider that lets someone enrol under an address they don't hold would
  // otherwise let them register that address here before its owner.
  it.each([
    ['false', { email_verified: false }],
    ['missing', {}],
  ])('refuses a first sign-in whose email_verified is %s, creating nothing (#912)', async (_state, verification) => {
    const { sub, email, username } = freshIdentity();

    const result = await signInThroughProvider(baseUrl, { sub, email, preferred_username: username, ...verification });

    expect(result.location.searchParams.get('error')).toBe('SIGN_IN_PROVIDER_EMAIL_UNVERIFIED');
    expect(result.location.searchParams.get('error_description')).toBe(
      "Your sign-in provider hasn't confirmed your email address, so you can't sign up with it here. Confirm the address with the provider, then try again",
    );
    expect(result.cookie).toBe('');
    await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
  });

  describe('while registration is closed', () => {
    const setRegistration = useSettingSwitch(() => db, 'allowUserRegistration');

    it('refuses a first sign-in with the code and a sentence for the client to show (#1016)', async () => {
      await setRegistration(false);
      const { sub, email } = freshIdentity();

      const result = await signInThroughProvider(baseUrl, { sub, email, email_verified: true });

      expect(result.location.searchParams.get('error')).toBe('REGISTRATION_DISABLED');
      expect(result.location.searchParams.get('error_description')).toBe('This server is not accepting new accounts');
      await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
    });
  });

  // The main fake's discovery omits `id_token_signing_alg_values_supported`, so
  // every other sign-in here fails if the server stops keying the Account row on
  // `sub`. An `id` claim is no stand-in, since it could name another user.
  it('refuses a first sign-in whose profile has an id claim but no sub, creating nothing (#1016)', async () => {
    const { sub, email } = freshIdentity();

    const result = await signInThroughProvider(baseUrl, { id: sub, email, email_verified: true });

    expect(result.location.searchParams.get('error')).toBe('unable_to_get_user_info');
    expect(result.cookie).toBe('');
    await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
  });

  // The user is created, but the row says what the provider said: nothing
  // that trusts an address, such as a household invite, trusts this one.
  // The Owner seat is filled first: on the swept install this user would be
  // the first human, whom provisioning marks verified after the callback.
  it('creates an unverified user through a provider allowed unverified emails (#912)', async () => {
    await actors.owner();
    const { sub, email, username } = freshIdentity();

    const result = await signInThroughProvider(
      baseUrl,
      { sub, email, preferred_username: username },
      { providerId: LENIENT_FAKE_PROVIDER_ID },
    );

    expect(result.location.href).toBe(new URL('/', baseUrl).href);
    const created = await userByEmail(email);
    expect(created).toMatchObject({ username, emailVerified: false });
    await expect(sessionUserId(result.cookie)).resolves.toBe(created.id);
  });

  it('gives a taken username its first free variant and tells the user (#912)', async () => {
    const existing = await actors.user();
    const { sub, email } = freshIdentity();

    const result = await signInThroughProvider(baseUrl, {
      sub,
      email,
      email_verified: true,
      preferred_username: existing.user.username,
    });

    // On the error page instead, the variant never reached the row and the
    // unique index on username refused it.
    expect(result.location.href).toBe(new URL('/', baseUrl).href);
    const created = await userByEmail(email);
    expect(created.username).toBe(`${existing.user.username}-2`);
    await expect(notificationsOf(created.id)).resolves.toEqual([
      expect.objectContaining({
        type: 'UsernameVariantAssigned',
        payload: {
          username: `${existing.user.username}-2`,
          requestedUsername: existing.user.username,
          usernameChangeAllowed: true,
        },
      }),
    ]);
  });

  describe('while username changes are off', () => {
    const setUsernameChange = useSettingSwitch(() => db, 'allowUsernameChange');

    // The listener reads the switch when it sends, so the payload follows it
    // rather than a constant.
    it('tells the user their variant can’t be changed (#912)', async () => {
      const existing = await actors.user();
      const { sub, email } = freshIdentity();
      await setUsernameChange(false);

      const result = await signInThroughProvider(baseUrl, {
        sub,
        email,
        email_verified: true,
        preferred_username: existing.user.username,
      });

      expect(result.location.href).toBe(new URL('/', baseUrl).href);
      const created = await userByEmail(email);
      await expect(notificationsOf(created.id)).resolves.toEqual([
        expect.objectContaining({
          type: 'UsernameVariantAssigned',
          payload: expect.objectContaining({ usernameChangeAllowed: false }),
        }),
      ]);
    });
  });

  /**
   * The provider's claims fill the profile at the first sign-in only. The
   * notification follows only a user's creation, and the second sign-in
   * creates none, as the unchanged id shows, so the count after it is final.
   */
  it('keeps a renamed profile on the next sign-in, and sends no second notification (#912)', async () => {
    const existing = await actors.user();
    const { sub, email, username: renamed } = freshIdentity();
    const claims = { sub, email, email_verified: true, preferred_username: existing.user.username, given_name: 'Ada' };

    const first = await signInThroughProvider(baseUrl, claims);
    expect(first.location.href).toBe(new URL('/', baseUrl).href);
    const created = await userByEmail(email);
    await notificationsOf(created.id);
    await db.client.user.update({ where: { id: created.id }, data: { username: renamed, firstName: 'Grace' } });

    const again = await signInThroughProvider(baseUrl, claims);

    expect(again.location.href).toBe(new URL('/', baseUrl).href);
    await expect(sessionUserId(again.cookie)).resolves.toBe(created.id);
    await expect(userByEmail(email)).resolves.toMatchObject({ id: created.id, username: renamed, firstName: 'Grace' });
    await expect(db.client.notification.count({ where: { userId: created.id } })).resolves.toBe(1);
  });

  /**
   * Both emails are verified, so better-auth's own conditions for a link a
   * sign-in makes itself all hold: only the provider linking policy, `SignedIn`
   * unless a server admin changes it, stops it (#913). The message is the policy
   * gate's: better-auth's own refusal carries none.
   */
  it('refuses a provider sign-in whose email belongs to a registered user, with account_not_linked (#912)', async () => {
    const existing = await actors.user();
    await db.client.user.update({ where: { id: existing.user.id }, data: { emailVerified: true } });
    const { sub } = freshIdentity();

    const result = await signInThroughProvider(baseUrl, {
      sub,
      email: existing.user.email,
      email_verified: true,
      preferred_username: 'someone',
    });

    expect(result.location.searchParams.get('error')).toBe('account_not_linked');
    expect(result.location.searchParams.get('error_description')).toBe(LINK_NEEDS_SIGN_IN_DESCRIPTION);
    expect(result.cookie).toBe('');
    await expect(
      db.client.account.count({ where: { userId: existing.user.id, providerId: FAKE_PROVIDER_ID } }),
    ).resolves.toBe(0);
  });

  /**
   * The gate lets a flow through whose OAuth state carries `link`, because only
   * a signed-in user's `/link-social` puts it there (#913). A client chooses the
   * `additionalData` that rides the same state, so a sign-in that names a
   * registered user under `link` there must meet the policy like any other.
   * better-auth writes its own `link` after the client's data today; this pins
   * that against an upgrade.
   */
  it('refuses a provider sign-in that names a registered user as its link in additionalData (#913)', async () => {
    const existing = await actors.user();
    await db.client.user.update({ where: { id: existing.user.id }, data: { emailVerified: true } });
    const { sub } = freshIdentity();

    const result = await signInThroughProvider(
      baseUrl,
      { sub, email: existing.user.email, email_verified: true, preferred_username: 'someone' },
      { additionalData: { link: { userId: existing.user.id, email: existing.user.email } } },
    );

    expect(result.location.searchParams.get('error')).toBe('account_not_linked');
    expect(result.location.searchParams.get('error_description')).toBe(LINK_NEEDS_SIGN_IN_DESCRIPTION);
    expect(result.cookie).toBe('');
    await expect(accountRowCount(FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
  });

  /**
   * A provider sign-in with a registered user's email links itself to that
   * user when the provider linking policy allows it (#913). Each test starts
   * under `SignedIn`, and sets the policy it needs.
   */
  describe('under automatic linking (#913)', () => {
    const setPolicy = useProviderLinkingPolicy(() => db);

    /** A registered user whose email this server has verified, as the Owner's is. */
    const verifiedUser = async () => {
      const existing = await actors.user();
      await db.client.user.update({ where: { id: existing.user.id }, data: { emailVerified: true } });

      return existing;
    };

    it('links a sign-in to the registered user with that email when both have verified it (#913)', async () => {
      await setPolicy(ProviderLinkingPolicy.AutomaticWhenVerified);
      const existing = await verifiedUser();
      const usersBefore = await db.client.user.count();
      const { sub } = freshIdentity();

      const result = await signInThroughProvider(baseUrl, {
        sub,
        email: existing.user.email,
        email_verified: true,
        preferred_username: 'someone',
      });

      expect(result.location.href).toBe(new URL('/', baseUrl).href);
      await expect(sessionUserId(result.cookie)).resolves.toBe(existing.user.id);
      await expect(
        db.client.account.findMany({
          where: { providerId: FAKE_PROVIDER_ID, accountId: sub },
          select: { userId: true },
        }),
      ).resolves.toEqual([{ userId: existing.user.id }]);
      await expect(db.client.user.count()).resolves.toBe(usersBefore);
    });

    // better-auth's own condition: the registered user's email must be
    // verified here too. Its refusal carries the code alone.
    it('refuses when the registered user’s email is unverified, with account_not_linked (#913)', async () => {
      await setPolicy(ProviderLinkingPolicy.AutomaticWhenVerified);
      const existing = await actors.user();
      await db.client.user.update({ where: { id: existing.user.id }, data: { emailVerified: false } });
      const { sub } = freshIdentity();

      const result = await signInThroughProvider(baseUrl, {
        sub,
        email: existing.user.email,
        email_verified: true,
        preferred_username: 'someone',
      });

      expect(result.location.searchParams.get('error')).toBe('account_not_linked');
      expect(result.cookie).toBe('');
      await expect(accountRowCount(FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
    });

    // A provider allowed unverified emails is trusted for linking, so
    // better-auth lets it past its own check on the provider's email. Only the
    // gate's check stops it, so this fails without that check.
    it('refuses a lenient provider that doesn’t confirm the email, with account_not_linked and a message (#913)', async () => {
      await setPolicy(ProviderLinkingPolicy.AutomaticWhenVerified);
      const existing = await verifiedUser();
      const { sub } = freshIdentity();

      const result = await signInThroughProvider(
        baseUrl,
        { sub, email: existing.user.email, preferred_username: 'someone' },
        { providerId: LENIENT_FAKE_PROVIDER_ID },
      );

      expect(result.location.searchParams.get('error')).toBe('account_not_linked');
      expect(result.location.searchParams.get('error_description')).toBe(LINK_EMAIL_UNVERIFIED_DESCRIPTION);
      expect(result.cookie).toBe('');
      await expect(accountRowCount(LENIENT_FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
    });

    // The gate reads the settings row on every link, so a server admin's change
    // needs no restart.
    it('applies a policy change on the next sign-in, with no restart (#913)', async () => {
      const existing = await verifiedUser();
      const { sub } = freshIdentity();
      const claims = { sub, email: existing.user.email, email_verified: true, preferred_username: 'someone' };

      const refused = await signInThroughProvider(baseUrl, claims);
      expect(refused.location.searchParams.get('error')).toBe('account_not_linked');
      await expect(accountRowCount(FAKE_PROVIDER_ID, sub)).resolves.toBe(0);

      await setPolicy(ProviderLinkingPolicy.AutomaticWhenVerified);
      const linked = await signInThroughProvider(baseUrl, claims);

      expect(linked.location.href).toBe(new URL('/', baseUrl).href);
      await expect(sessionUserId(linked.cookie)).resolves.toBe(existing.user.id);
      await expect(accountRowCount(FAKE_PROVIDER_ID, sub)).resolves.toBe(1);
    });
  });

  it('links a provider with a different email to a signed-in user, then signs that user in through it (#912)', async () => {
    const existing = await actors.user();
    const { sub } = freshIdentity();
    const providerEmail = `other-${sub}@example.test`;

    // better-auth 1.7 links a provider that isn't one of its trusted ones only
    // when the provider vouches for the email (#1016).
    const linked = await signInThroughProvider(
      baseUrl,
      { sub, email: providerEmail, email_verified: true },
      { linkWith: existing.headers },
    );

    expect(linked.location.href).toBe(new URL('/', baseUrl).href);
    await expect(
      db.client.account.count({ where: { userId: existing.user.id, providerId: FAKE_PROVIDER_ID, accountId: sub } }),
    ).resolves.toBe(1);

    const again = await signInThroughProvider(baseUrl, { sub, email: providerEmail });

    expect(again.location.href).toBe(new URL('/', baseUrl).href);
    await expect(sessionUserId(again.cookie)).resolves.toBe(existing.user.id);
    await expect(db.client.user.count({ where: { email: providerEmail } })).resolves.toBe(0);
  });

  /**
   * Starting a link needs a session signed in within a day (#913). The (#912)
   * link test above starts one from a fresh session. Each session here is aged
   * in the store, which stands in for waiting out the day, and each still
   * signs its user in, so the refusal is about its age alone.
   */
  describe('starting a link from an old session', () => {
    const LINK_PATH = '/api/auth/link-social';
    const SIGN_IN_PATH = '/api/auth/sign-in/email';
    const A_DAY_AND_AN_HOUR_MS = 25 * 60 * 60 * 1000;

    const NEEDS_RECENT_SIGN_IN_BODY = {
      code: 'PROVIDER_LINK_NEEDS_RECENT_SIGN_IN',
      message: 'Linking a sign-in provider needs a recent sign-in. Sign in again, then link it',
    } as const;

    /** The session token a credential names: the part before its signature, which the store is keyed on. */
    const sessionToken = (credential: string) => decodeURIComponent(credential).split('.')[0];

    /**
     * Starts a link to the fake provider with `headers` and expects the refusal.
     * The status and body tell it apart from a link that started: that would
     * answer 200 with the provider's URL. The Account row would be written only
     * on the provider's callback, so the count just confirms nothing was
     * written before it.
     */
    const expectLinkRefused = async (userId: string, headers: Record<string, string>) => {
      const response = await postToAuth(baseUrl, LINK_PATH)
        .set(headers)
        .send({ provider: FAKE_PROVIDER_ID, callbackURL: '/' });

      expect(response.status).toBe(403);
      expect(response.body).toEqual(NEEDS_RECENT_SIGN_IN_BODY);
      await expect(db.client.account.count({ where: { userId, providerId: FAKE_PROVIDER_ID } })).resolves.toBe(0);
    };

    // Native apps and API callers send a bearer credential. Every before hook
    // sees it as sent, and the bearer plugin hands the route its session only
    // after them, so a check that read only the cookie would let these through.
    it('refuses to start a link from a session signed in more than a day ago, with PROVIDER_LINK_NEEDS_RECENT_SIGN_IN (#913)', async () => {
      const existing = await actors.user();
      await ageStoredSession(sessionToken(existing.credentials.token), A_DAY_AND_AN_HOUR_MS);

      await expect(sessionUserOf(existing.headers)).resolves.toBe(existing.user.id);
      await expectLinkRefused(existing.user.id, existing.headers);
    });

    it('refuses to start a link from a password sign-in’s cookie more than a day old, as a browser sends it (#913)', async () => {
      const existing = await actors.user();
      const signIn = await postToAuth(baseUrl, SIGN_IN_PATH)
        .send({ email: existing.user.email, password: existing.password })
        .expect(200);
      const cookie = sessionCookieOf(signIn.headers['set-cookie']);
      await ageStoredSession(sessionToken(cookie.slice(cookie.indexOf('=') + 1)), A_DAY_AND_AN_HOUR_MS);

      await expect(sessionUserId(cookie)).resolves.toBe(existing.user.id);
      await expectLinkRefused(existing.user.id, { Cookie: cookie });
    });
  });

  /**
   * better-auth 1.7 unlinks by the Account row's own `id`: `providerId` is no
   * longer part of the body (#1016). A signed-up user already holds a
   * password sign-in method, so a linked provider is never their last, and
   * what these tests exercise is the body, not the refusal to unlink a
   * user's last sign-in method.
   */
  describe('unlinking a sign-in provider', () => {
    const UNLINK_PATH = '/api/auth/unlink-account';

    const linkedProvider = async () => {
      const existing = await actors.user();
      const { sub } = freshIdentity();
      await signInThroughProvider(
        baseUrl,
        { sub, email: `other-${sub}@example.test`, email_verified: true },
        { linkWith: existing.headers },
      );
      const account = await db.client.account.findFirstOrThrow({
        where: { userId: existing.user.id, providerId: FAKE_PROVIDER_ID, accountId: sub },
        select: { id: true },
      });

      return { existing, account };
    };

    it('unlinks by the Account row’s id (#1016)', async () => {
      const { existing, account } = await linkedProvider();
      await expect(db.client.account.count({ where: { userId: existing.user.id } })).resolves.toBe(2);

      const response = await postToAuth(baseUrl, UNLINK_PATH).set(existing.headers).send({ accountId: account.id });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: true });
      await expect(db.client.account.count({ where: { id: account.id } })).resolves.toBe(0);
      await expect(db.client.account.count({ where: { userId: existing.user.id } })).resolves.toBe(1);
    });

    // The 1.6 body named the provider. A client still sending it is refused
    // for the missing `accountId`, not for the last-sign-in-method rule or an
    // unknown Account row, and the link stays.
    it('answers 400 to an unlink naming a providerId, and removes nothing (#1016)', async () => {
      const { existing, account } = await linkedProvider();

      const response = await postToAuth(baseUrl, UNLINK_PATH)
        .set(existing.headers)
        .send({ providerId: FAKE_PROVIDER_ID });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.message).toContain('accountId');
      await expect(db.client.account.count({ where: { id: account.id } })).resolves.toBe(1);
      await expect(db.client.account.count({ where: { userId: existing.user.id } })).resolves.toBe(2);
    });
  });

  /**
   * A provider that publishes a JWKS has its ID token checked against it, and
   * against the nonce the sign-in sent (#1016). The claims are that token's
   * merged with `/userinfo`'s answer; where both give a claim, the token's
   * wins (#993). The token is checked before `/userinfo` is asked, and the fake
   * counts its `/userinfo` calls. Each spoiled token has one thing wrong and
   * otherwise carries a sound one's claims, which `/userinfo` would answer for
   * too: refused with no call to it, the token's check is what refused it.
   */
  describe('a provider that signs its ID token', () => {
    // The control for the counts below: a provider with no JWKS has nothing to
    // verify, so the claims come from `/userinfo`, and the fake counts the call.
    it('reads the claims of a provider that publishes no JWKS from its userinfo endpoint (#1016)', async () => {
      const { sub, email } = freshIdentity();

      const result = await signInThroughProvider(baseUrl, { sub, email, email_verified: true });

      expect(result.location.href).toBe(new URL('/', baseUrl).href);
      const recorded = await ticketOf(result.ticket);
      expect(recorded.nonce).toBeNull();
      expect(recorded.userInfoCalls).toBe(1);
    });

    it('signs in through a provider whose ID token verifies against its JWKS (#1016)', async () => {
      const { sub, email, username } = freshIdentity();

      const result = await signInThroughProvider(
        baseUrl,
        { sub, email, email_verified: true, preferred_username: username, given_name: 'Ada', family_name: 'Lovelace' },
        { providerId: SIGNED_FAKE_PROVIDER_ID },
      );

      expect(result.location.href).toBe(new URL('/', baseUrl).href);
      const created = await userByEmail(email);
      expect(created).toMatchObject({ username, firstName: 'Ada', lastName: 'Lovelace', emailVerified: true });
      await expect(sessionUserId(result.cookie)).resolves.toBe(created.id);
      await expect(accountRowCount(SIGNED_FAKE_PROVIDER_ID, sub)).resolves.toBe(1);
      const recorded = await ticketOf(result.ticket);
      expect(recorded.nonce).toEqual(expect.any(String));
      // UserInfo is asked as well, for what the token leaves out (#993).
      expect(recorded.userInfoCalls).toBe(1);
    });

    it.each(['forged', 'wrong-nonce', 'wrong-audience', 'wrong-issuer', 'expired'] as const)(
      'refuses a %s ID token, creating nothing (#1016, #1038)',
      async (idToken) => {
        const { sub, email, username } = freshIdentity();

        const result = await signInThroughProvider(
          baseUrl,
          { sub, email, email_verified: true, preferred_username: username },
          { providerId: SIGNED_FAKE_PROVIDER_ID, idToken },
        );

        expect(result.location.searchParams.get('error')).toBe('unable_to_get_user_info');
        expect(result.cookie).toBe('');
        await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
        await expect(accountRowCount(SIGNED_FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
        await expect(ticketOf(result.ticket)).resolves.toMatchObject({ userInfoCalls: 0 });
      },
    );

    // A provider can leave `email_verified` out of the ID token and send it
    // only from UserInfo, so the token alone refused its users.
    it('takes email_verified from UserInfo when the ID token leaves it out (#993)', async () => {
      const { sub, email, username } = freshIdentity();

      const result = await signInThroughProvider(
        baseUrl,
        { sub, email, preferred_username: username },
        { providerId: SIGNED_FAKE_PROVIDER_ID, userInfo: { sub, email, email_verified: true } },
      );

      expect(result.location.href).toBe(new URL('/', baseUrl).href);
      const created = await userByEmail(email);
      expect(created).toMatchObject({ username, emailVerified: true });
      await expect(sessionUserId(result.cookie)).resolves.toBe(created.id);
      await expect(ticketOf(result.ticket)).resolves.toMatchObject({ userInfoCalls: 1 });
    });

    // The username differs from the email's local part, which the mapping
    // falls back to, so it can only have come from UserInfo.
    it('takes the username and names from UserInfo when the ID token has only the subject and email (#993)', async () => {
      const { sub, email, username } = freshIdentity();
      const userInfoUsername = `${username}-userinfo`;

      const result = await signInThroughProvider(
        baseUrl,
        { sub, email, email_verified: true },
        {
          providerId: SIGNED_FAKE_PROVIDER_ID,
          userInfo: { sub, email, preferred_username: userInfoUsername, given_name: 'Ada', family_name: 'Lovelace' },
        },
      );

      expect(result.location.href).toBe(new URL('/', baseUrl).href);
      await expect(userByEmail(email)).resolves.toMatchObject({
        username: userInfoUsername,
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailVerified: true,
      });
    });

    it('refuses a sign-in whose UserInfo answers for another subject, creating nothing (#993)', async () => {
      const { sub, email } = freshIdentity();

      const result = await signInThroughProvider(
        baseUrl,
        { sub, email, email_verified: true },
        { providerId: SIGNED_FAKE_PROVIDER_ID, userInfo: { sub: randomUUID(), email, email_verified: true } },
      );

      expect(result.location.searchParams.get('error')).toBe('unable_to_get_user_info');
      expect(result.cookie).toBe('');
      await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
      await expect(accountRowCount(SIGNED_FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
    });

    // A confirmation counts only beside its own address: UserInfo vouching
    // for another one says nothing about the address the ID token gives.
    it("doesn't count a UserInfo confirmation for another address (#993)", async () => {
      const { sub, email } = freshIdentity();
      const otherEmail = `other-${email}`;

      const result = await signInThroughProvider(
        baseUrl,
        { sub, email },
        { providerId: SIGNED_FAKE_PROVIDER_ID, userInfo: { sub, email: otherEmail, email_verified: true } },
      );

      expect(result.location.searchParams.get('error')).toBe('SIGN_IN_PROVIDER_EMAIL_UNVERIFIED');
      expect(result.cookie).toBe('');
      await expect(db.client.user.count({ where: { email: { in: [email, otherEmail] } } })).resolves.toBe(0);
    });
  });

  /**
   * What the server settles about a sign-in provider beyond signing in with it
   * (#1016): which providers may be linked without vouching for the email,
   * that sign-out stays here, and that no client submits a provider's token.
   */
  describe('linking, signing out and submitted ID tokens', () => {
    // A provider the operator allows unverified emails for never sends the
    // claim, and better-auth links an unvouched email only for a provider it
    // trusts. A link starts from a signed-in session, so the email isn't what
    // grants access.
    it('links a provider allowed unverified emails, without email_verified (#1016)', async () => {
      const existing = await actors.user();
      const { sub } = freshIdentity();

      const linked = await signInThroughProvider(
        baseUrl,
        { sub, email: `other-${sub}@example.test` },
        { linkWith: existing.headers, providerId: LENIENT_FAKE_PROVIDER_ID },
      );

      expect(linked.location.href).toBe(new URL('/', baseUrl).href);
      await expect(
        db.client.account.count({
          where: { userId: existing.user.id, providerId: LENIENT_FAKE_PROVIDER_ID, accountId: sub },
        }),
      ).resolves.toBe(1);
    });

    it('refuses to link a strict provider that doesn’t confirm the email (#1016)', async () => {
      const existing = await actors.user();
      const { sub } = freshIdentity();

      const result = await signInThroughProvider(
        baseUrl,
        { sub, email: `other-${sub}@example.test` },
        { linkWith: existing.headers },
      );

      expect(result.location.searchParams.get('error')).toBe('unable_to_link_account');
      await expect(accountRowCount(FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
    });

    /**
     * Trusting a provider for linking also lets its sign-in past better-auth's
     * check on the provider's email, for a user that email already belongs to.
     * Only the provider linking gate stops it now, under the `SignedIn` policy
     * (#913). The registered user's email is verified, and the provider's
     * claim isn't there, as with a provider that never sends it.
     */
    it('refuses a lenient provider’s sign-in with a registered user’s email, with account_not_linked (#1016)', async () => {
      const existing = await actors.user();
      await db.client.user.update({ where: { id: existing.user.id }, data: { emailVerified: true } });
      const { sub } = freshIdentity();

      const result = await signInThroughProvider(
        baseUrl,
        { sub, email: existing.user.email, preferred_username: 'someone' },
        { providerId: LENIENT_FAKE_PROVIDER_ID },
      );

      expect(result.location.searchParams.get('error')).toBe('account_not_linked');
      expect(result.location.searchParams.get('error_description')).toBe(LINK_NEEDS_SIGN_IN_DESCRIPTION);
      expect(result.cookie).toBe('');
      await expect(accountRowCount(LENIENT_FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
      await expect(db.client.user.count({ where: { email: existing.user.email } })).resolves.toBe(1);
    });

    // The fake lists an `end_session_endpoint`, so better-auth could answer
    // with a provider URL. Two things each stop it on their own: the sign-out
    // hook deletes the session before the route looks for it, and
    // `disableProviderLogout`, which `auth-factory.spec.ts` pins, switches the
    // URL off. So this passes with either one removed and fails only with both
    // gone (#1016). Sign-out stays here until #1018 decides.
    it('answers sign-out with no provider URL for a user with a linked provider (#1016)', async () => {
      const existing = await actors.user();
      const { sub } = freshIdentity();
      await signInThroughProvider(
        baseUrl,
        { sub, email: `other-${sub}@example.test`, email_verified: true },
        { linkWith: existing.headers },
      );
      await expect(accountRowCount(FAKE_PROVIDER_ID, sub)).resolves.toBe(1);
      const discovery = await request(fakeProviderUrl()).get('/.well-known/openid-configuration').expect(200);
      expect(discovery.body.end_session_endpoint).toEqual(expect.any(String));
      await expect(sessionUserOf(existing.headers)).resolves.toBe(existing.user.id);

      const response = await postToAuth(baseUrl, SIGN_OUT_PATH).set(existing.headers).send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(response.body).not.toHaveProperty('url');
      expect(response.body).not.toHaveProperty('redirect');
      expect(response.headers).not.toHaveProperty('location');
      await expect(sessionUserOf(existing.headers)).resolves.toBeUndefined();
    });

    // Sent without the redirect flow's state and PKCE, a provider's token is a
    // second way in that nothing here uses. The fake lists no JWKS, so
    // better-auth would refuse it on its own with a 404: the code and the 403
    // are the gate's. The token carries claims that would sign a user in or
    // link a provider if it were believed.
    it.each([
      ['/api/auth/sign-in/social', false],
      ['/api/auth/link-social', true],
    ])('refuses an ID token submitted to %s, creating no user and linking nothing (#1016)', async (path, signedIn) => {
      const { sub, email } = freshIdentity();
      const idToken = unsignedIdToken({
        iss: fakeProviderUrl(),
        aud: 'e2e-client',
        sub,
        email,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 600,
      });

      const submission = postToAuth(baseUrl, path);
      const response = await (signedIn ? submission.set((await actors.user()).headers) : submission).send({
        provider: FAKE_PROVIDER_ID,
        idToken: { token: idToken },
        callbackURL: '/',
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual(ID_TOKEN_REFUSED_BODY);
      await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
      await expect(accountRowCount(FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
    });

    // The one submission better-auth would believe: the signed fake publishes a
    // JWKS, and this token verifies against it, with no nonce to check since
    // none was asked for. Without the gate it signs the new user in, or links
    // the provider to the signed-in user.
    it.each([
      ['/api/auth/sign-in/social', false],
      ['/api/auth/link-social', true],
    ])(
      'refuses a validly signed ID token submitted to %s, creating no user and linking nothing (#1016)',
      async (path, signedIn) => {
        const { sub, email } = freshIdentity();
        const idToken = await signedIdToken({ sub, email, email_verified: true });

        const submission = postToAuth(baseUrl, path);
        const response = await (signedIn ? submission.set((await actors.user()).headers) : submission).send({
          provider: SIGNED_FAKE_PROVIDER_ID,
          idToken: { token: idToken },
          callbackURL: '/',
        });

        expect(response.status).toBe(403);
        expect(response.body).toEqual(ID_TOKEN_REFUSED_BODY);
        await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
        await expect(accountRowCount(SIGNED_FAKE_PROVIDER_ID, sub)).resolves.toBe(0);
      },
    );
  });
});
