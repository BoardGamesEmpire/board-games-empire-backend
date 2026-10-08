import { createActors, type Actors } from '@bge/testing-e2e';
import { postToAuth } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { useSettingSwitch } from '../support/setting-switch';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const REQUEST_RESET_PATH = '/api/auth/request-password-reset';
const RESET_PATH = '/api/auth/reset-password';
const CHANGE_PASSWORD_PATH = '/api/auth/change-password';

const REFUSAL = {
  code: 'PASSWORD_RESET_DISABLED',
  message: 'Password resets are turned off on this server',
};

/**
 * The settings row's password-reset switch (#585).
 *
 * No reset can succeed yet, switch on or off: nothing in the server sends
 * mail (#654), so better-auth answers its own `RESET_PASSWORD_DISABLED` once
 * past the switch. That answer is what shows the switch let a request
 * through.
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

  describe('asking for a reset', () => {
    it('reaches better-auth while resets are on', async () => {
      const user = await actors.user();

      const response = await postToAuth(baseUrl, REQUEST_RESET_PATH).send({ email: user.user.email });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'RESET_PASSWORD_DISABLED' });
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

  it('leaves a signed-in password change alone while resets are off, since it is not a reset', async () => {
    const user = await actors.user();
    await setSwitch(false);

    await postToAuth(baseUrl, CHANGE_PASSWORD_PATH)
      .set(user.headers)
      .send({ currentPassword: user.password, newPassword: 'E2e!Changed12345' })
      .expect(200);
  });
});
