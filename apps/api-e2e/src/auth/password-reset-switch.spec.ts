import { MAIL_QUEUE_NAME } from '@bge/queue-mail';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { postToAuth } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { useMailSettings } from '../support/mail-settings';
import { isolateQueue } from '../support/queue-isolation';
import { waitForStableJobCount } from '../support/queues';
import { useSettingSwitch } from '../support/setting-switch';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const REQUEST_RESET_PATH = '/api/auth/request-password-reset';
const RESET_PATH = '/api/auth/reset-password';
const CHANGE_PASSWORD_PATH = '/api/auth/change-password';
const DISCOVERY_PATH = '/.well-known/bge-identity';

const REFUSAL = {
  code: 'PASSWORD_RESET_DISABLED',
  message: 'Password resets are turned off on this server',
};

/**
 * The settings row's password-reset switch (#585).
 *
 * While it is on, a reset request that names where the link should open is
 * accepted and its mail queued, once the mail settings point somewhere (#654).
 * While it is off, both asking for a reset and finishing one are refused,
 * whatever the mail settings say. Discovery advertises asking for a reset only
 * while the switch is on and outgoing mail is set up, and finishing one while
 * the switch is on. The mail itself, and the reset it
 * finishes, are `password-reset-mail.spec.ts`'s: no worker runs here, so a
 * queued mail stays in the queue, and `isolateQueue` removes it.
 */
describe('the password-reset switch', () => {
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

  const setSwitch = useSettingSwitch(() => db, 'allowPasswordResets');
  const mail = useMailSettings(() => db);
  const mailQueue = isolateQueue(MAIL_QUEUE_NAME);

  describe('asking for a reset', () => {
    it('is accepted while resets are on, and queues the reset mail (#654)', async () => {
      const user = await actors.user();
      await mail.pointAtMailpit();

      const response = await postToAuth(baseUrl, REQUEST_RESET_PATH).send({
        email: user.user.email,
        redirectTo: `${baseUrl}/reset`,
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: true });
      await waitForStableJobCount(mailQueue(), 1);
    });

    it('is refused with 400 when the app names no redirectTo (#654)', async () => {
      const user = await actors.user();

      const response = await postToAuth(baseUrl, REQUEST_RESET_PATH).send({ email: user.user.email });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'PASSWORD_RESET_REDIRECT_REQUIRED' });
    });

    it('is refused with 403 while resets are off', async () => {
      const user = await actors.user();
      await setSwitch(false);

      const response = await postToAuth(baseUrl, REQUEST_RESET_PATH).send({ email: user.user.email });

      expect(response.status).toBe(403);
      expect(response.body).toEqual(REFUSAL);
    });
  });

  // Refused too, so a link sent before resets were switched off cannot
  // finish a reset afterwards.
  describe('finishing a reset', () => {
    it('reaches better-auth while resets are on', async () => {
      const response = await postToAuth(baseUrl, RESET_PATH).send({
        token: 'not-a-reset-token',
        newPassword: 'E2e!Reset12345',
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('is refused with 403 while resets are off', async () => {
      await setSwitch(false);

      const response = await postToAuth(baseUrl, RESET_PATH).send({
        token: 'not-a-reset-token',
        newPassword: 'E2e!Reset12345',
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual(REFUSAL);
    });
  });

  /**
   * Discovery's email strategy, which a client reads to decide whether to
   * offer "forgot password" at all (#654). Read once before each change, as
   * `registration-switch.spec.ts` does, so a cached answer can't pass.
   */
  describe('in discovery', () => {
    const emailStrategy = async () => {
      const { body } = await request(baseUrl).get(DISCOVERY_PATH).expect(200);
      return (body.strategies as Array<{ type: string }>).find((strategy) => strategy.type === 'email_and_password');
    };

    it('offers no reset request on the seeded row, which has no mail settings, but still lists finishing one (#654)', async () => {
      const strategy = await emailStrategy();

      expect(strategy).toMatchObject({ password_reset_available: false, reset_password_endpoint: RESET_PATH });
      expect(strategy).not.toHaveProperty('request_password_reset_endpoint');
    });

    it('offers a reset, with both endpoints, once the mail settings point at a server (#654)', async () => {
      await expect(emailStrategy()).resolves.toMatchObject({ password_reset_available: false });

      await mail.pointAtMailpit();

      await expect(emailStrategy()).resolves.toMatchObject({
        password_reset_available: true,
        request_password_reset_endpoint: REQUEST_RESET_PATH,
        reset_password_endpoint: RESET_PATH,
      });
    });

    it('offers no reset while resets are off, even with mail set up (#654)', async () => {
      await mail.pointAtMailpit();
      await expect(emailStrategy()).resolves.toMatchObject({ password_reset_available: true });

      await setSwitch(false);

      const strategy = await emailStrategy();
      expect(strategy).toMatchObject({ password_reset_available: false });
      expect(strategy).not.toHaveProperty('request_password_reset_endpoint');
      expect(strategy).not.toHaveProperty('reset_password_endpoint');
    });
  });

  it('leaves a signed-in password change alone while resets are off, since it is not a reset', async () => {
    const user = await actors.user();
    await setSwitch(false);

    await postToAuth(baseUrl, CHANGE_PASSWORD_PATH)
      .set(user.headers)
      .send({ currentPassword: user.password, newPassword: 'E2e!Changed12345' })
      .expect(200);
  });
});
