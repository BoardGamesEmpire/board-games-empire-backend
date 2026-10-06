import { createActors, type Actors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import { postToAuth, signInAgain } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { useSettingSwitch } from '../support/setting-switch';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const UPDATE_USER_PATH = '/api/auth/update-user';
const ADMIN_UPDATE_USER_PATH = '/api/auth/admin/update-user';

/**
 * The settings row's username-change switch (#585). better-auth maps its
 * `name` onto the `username` column, so `/update-user` is where a username
 * changes, and the switch is enforced there.
 */
describe('the username-change switch', () => {
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

  const setSwitch = useSettingSwitch(() => db, 'allowUsernameChange');

  const storedUser = (id: string) =>
    db.client.user.findUniqueOrThrow({ where: { id }, select: { username: true, firstName: true } });

  const freshUsername = () => `e2e-renamed-${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  it('lets users change their username while changes are on', async () => {
    const user = await actors.user();
    const username = freshUsername();

    await postToAuth(baseUrl, UPDATE_USER_PATH).set(user.headers).send({ name: username }).expect(200);

    await expect(storedUser(user.user.id)).resolves.toMatchObject({ username });
  });

  it('refuses a username change with 403 while changes are off, and keeps the username', async () => {
    const user = await actors.user();
    await setSwitch(false);

    const response = await postToAuth(baseUrl, UPDATE_USER_PATH).set(user.headers).send({ name: freshUsername() });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: 'USERNAME_CHANGE_DISABLED',
      message: 'Username changes are turned off on this server',
    });
    await expect(storedUser(user.user.id)).resolves.toMatchObject({ username: user.user.username });
  });

  it('saves the rest of a profile that resends the current username while changes are off', async () => {
    const user = await actors.user();
    await setSwitch(false);

    await postToAuth(baseUrl, UPDATE_USER_PATH)
      .set(user.headers)
      .send({ name: user.user.username, firstName: 'Ada' })
      .expect(200);

    await expect(storedUser(user.user.id)).resolves.toEqual({ username: user.user.username, firstName: 'Ada' });
  });

  it('still lets an admin change a username while changes are off', async () => {
    const headers = await signInAgain(baseUrl, await actors.owner());
    const user = await actors.user();
    const username = freshUsername();
    await setSwitch(false);

    await postToAuth(baseUrl, ADMIN_UPDATE_USER_PATH)
      .set(headers)
      .send({ userId: user.user.id, data: { name: username } })
      .expect(200);

    await expect(storedUser(user.user.id)).resolves.toMatchObject({ username });
  });
});
