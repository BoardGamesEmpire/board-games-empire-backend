import { createActors, pollUntil, type Actors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { FAKE_PROVIDER_ID, fakeProviderEnv, LENIENT_FAKE_PROVIDER_ID, requireBaseUrl } from '../support/e2e-env';
import { useSettingSwitch } from '../support/setting-switch';
import { fakeProviderUrl, signInThroughProvider } from '../support/sign-in-provider';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const GET_SESSION_PATH = '/api/auth/get-session';
const DISCOVERY_PATH = '/.well-known/bge-identity';

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

  /** The user a session cookie signs in as, read the way a client reads it. */
  const sessionUserId = async (cookie: string): Promise<string | undefined> => {
    const response = await request(baseUrl).get(GET_SESSION_PATH).set('Cookie', cookie).expect(200);

    return response.body?.user?.id;
  };

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
        authorization_endpoint: '/api/auth/sign-in/oauth2',
        sign_up_disabled: false,
      },
      {
        type: 'oidc',
        provider_id: LENIENT_FAKE_PROVIDER_ID,
        display_name: 'Lenient fake provider',
        discovery_url: providerEnv.OIDC_FAKE_LENIENT_DISCOVERY_URL,
        authorization_endpoint: '/api/auth/sign-in/oauth2',
        sign_up_disabled: false,
      },
    ]);
    for (const secret of [
      providerEnv.OIDC_FAKE_CLIENT_ID,
      providerEnv.OIDC_FAKE_CLIENT_SECRET,
      providerEnv.OIDC_FAKE_LENIENT_CLIENT_ID,
      providerEnv.OIDC_FAKE_LENIENT_CLIENT_SECRET,
    ]) {
      expect(response.text).not.toContain(secret);
    }
  });

  it('asks the provider for openid, profile and email (#912)', async () => {
    const { sub, email } = freshIdentity();

    const { ticket } = await signInThroughProvider(baseUrl, { sub, email, email_verified: true });

    const response = await request(fakeProviderUrl()).get(`/tickets/${ticket}`).expect(200);
    expect(response.body.scope.split(' ')).toEqual(['openid', 'profile', 'email']);
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
    expect(result.cookie).toBe('');
    await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
  });

  // The user is created, but the row says what the provider said: nothing
  // that trusts an address, such as a household invite, trusts this one.
  it('creates an unverified user through a provider allowed unverified emails (#912)', async () => {
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
   * Both emails are verified, so better-auth's own conditions for linking on
   * its own all hold: only the server's refusal to link implicitly stops it.
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
    expect(result.cookie).toBe('');
    await expect(
      db.client.account.count({ where: { userId: existing.user.id, providerId: FAKE_PROVIDER_ID } }),
    ).resolves.toBe(0);
  });

  it('links a provider with a different email to a signed-in user, then signs that user in through it (#912)', async () => {
    const existing = await actors.user();
    const { sub } = freshIdentity();
    const providerEmail = `other-${sub}@example.test`;

    const linked = await signInThroughProvider(baseUrl, { sub, email: providerEmail }, { linkWith: existing.headers });

    expect(linked.location.href).toBe(new URL('/', baseUrl).href);
    await expect(
      db.client.account.count({ where: { userId: existing.user.id, providerId: FAKE_PROVIDER_ID, accountId: sub } }),
    ).resolves.toBe(1);

    const again = await signInThroughProvider(baseUrl, { sub, email: providerEmail });

    expect(again.location.href).toBe(new URL('/', baseUrl).href);
    await expect(sessionUserId(again.cookie)).resolves.toBe(existing.user.id);
    await expect(db.client.user.count({ where: { email: providerEmail } })).resolves.toBe(0);
  });
});
