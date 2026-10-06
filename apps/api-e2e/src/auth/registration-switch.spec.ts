import {
  createActors,
  performSignup,
  prepareSignup,
  SIGN_IN_ANONYMOUS_PATH,
  SIGN_UP_EMAIL_PATH,
  type Actors,
} from '@bge/testing-e2e';
import request from 'supertest';
import { postToAuth, signInAgain } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { useSettingSwitch } from '../support/setting-switch';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const ADMIN_CREATE_USER_PATH = '/api/auth/admin/create-user';
const DISCOVERY_PATH = '/.well-known/bge-identity';

const REFUSAL = {
  code: 'REGISTRATION_DISABLED',
  message: 'This server is not accepting new accounts',
};

/**
 * The settings row's registration switch (#585). It used to be stored and
 * enforced nowhere; now every account creation better-auth makes reads it,
 * except an admin's.
 */
describe('the registration switch', () => {
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

  const setRegistration = useSettingSwitch(() => db, 'allowUserRegistration');

  const countUsersWithEmail = (email: string) => db.client.user.count({ where: { email } });

  it('refuses an email sign-up with 403 and creates no account', async () => {
    await setRegistration(false);
    const { body, email } = prepareSignup();

    const response = await postToAuth(baseUrl, SIGN_UP_EMAIL_PATH).send(body);

    expect(response.status).toBe(403);
    expect(response.body).toEqual(REFUSAL);
    await expect(countUsersWithEmail(email)).resolves.toBe(0);
  });

  it('gives a registered email the same answer, so a closed server does not say which emails hold accounts', async () => {
    const existing = await actors.user();
    await setRegistration(false);

    const response = await postToAuth(baseUrl, SIGN_UP_EMAIL_PATH).send(
      prepareSignup({ email: existing.user.email }).body,
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual(REFUSAL);
  });

  it('refuses an anonymous sign-in, which would create an account', async () => {
    await setRegistration(false);
    const anonymousBefore = await db.client.user.count({ where: { isAnonymous: true } });

    const response = await postToAuth(baseUrl, SIGN_IN_ANONYMOUS_PATH).send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual(REFUSAL);
    await expect(db.client.user.count({ where: { isAnonymous: true } })).resolves.toBe(anonymousBefore);
  });

  it('still lets an admin create an account', async () => {
    const headers = await signInAgain(baseUrl, await actors.owner());
    await setRegistration(false);
    const { body, email } = prepareSignup();

    const response = await postToAuth(baseUrl, ADMIN_CREATE_USER_PATH)
      .set(headers)
      .send({ email, password: body.password, name: body.name });

    expect(response.status).toBe(200);
    await expect(countUsersWithEmail(email)).resolves.toBe(1);
  });

  it('takes a change on the next request, with no restart', async () => {
    await setRegistration(false);
    await postToAuth(baseUrl, SIGN_UP_EMAIL_PATH).send(prepareSignup().body).expect(403);

    await setRegistration(true);
    await expect(performSignup(baseUrl)).resolves.toMatchObject({ userId: expect.any(String) });
  });

  /**
   * Read once before the change on purpose. The api response-caches GETs per
   * caller unless a route opts out, and without the first read the last one
   * would pass with the cache still on.
   */
  it('shows in discovery on the next read', async () => {
    const readDiscovery = async () => (await request(baseUrl).get(DISCOVERY_PATH).expect(200)).body;
    const emailStrategy = (discovery: { strategies: Array<{ type: string }> }) =>
      discovery.strategies.find((strategy) => strategy.type === 'email_and_password');

    const before = await readDiscovery();
    expect(before.bge_anonymous_auth_supported).toBe(true);
    expect(emailStrategy(before)).toMatchObject({ sign_up_disabled: false, sign_up_endpoint: SIGN_UP_EMAIL_PATH });

    await setRegistration(false);

    const after = await readDiscovery();
    expect(after.bge_anonymous_auth_supported).toBe(false);
    expect(emailStrategy(after)).toMatchObject({ sign_up_disabled: true });
    expect(emailStrategy(after)).not.toHaveProperty('sign_up_endpoint');
  });
});
