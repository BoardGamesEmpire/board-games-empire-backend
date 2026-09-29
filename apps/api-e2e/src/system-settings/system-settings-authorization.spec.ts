import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * Who may change the server's settings (#441). `Admin` holds
 * `update:system_setting`, the Owner holds everything, and nobody else may
 * write. Who may read is not under test: both staff roles already read every
 * subject through their `read` on `all`.
 *
 * The admin does read the settings before and after their write, as a
 * settings screen does. The api response-caches GETs per caller unless a
 * route opts out, and a cached read repeats the value from before the write.
 * Without the first read, the last assertion would pass with the cache on.
 *
 * The settings row is on the isolation sweep's preserved list, so a write
 * here would outlive the test. Each test restores the row it changed.
 */
describe('system settings authorization', () => {
  const baseUrl = requireBaseUrl(process.env);
  const SETTINGS_PATH = '/api/system-settings';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const readSettings = () =>
    db.client.systemSetting.findUniqueOrThrow({
      where: { singleton: true },
      select: { id: true, allowUsernameChange: true },
    });

  let original: Awaited<ReturnType<typeof readSettings>>;

  beforeEach(async () => {
    original = await readSettings();
  });

  afterEach(async () => {
    await db.client.systemSetting.update({
      where: { id: original.id },
      data: { allowUsernameChange: original.allowUsernameChange },
    });
  });

  const readOverHttp = async (actor: SessionActor) => {
    const { body } = await request(baseUrl).get(SETTINGS_PATH).set(actor.headers).expect(200);

    return body;
  };

  it('lets an admin change a setting and read the change back, and refuses a moderator and a plain user the same write', async () => {
    const [admin, moderator, user] = await Promise.all([actors.admin(), actors.moderator(), actors.user()]);
    const path = `${SETTINGS_PATH}/${original.id}`;
    const payload = { allowUsernameChange: !original.allowUsernameChange };

    await expect(readOverHttp(admin)).resolves.toMatchObject({
      settings: { allowUsernameChange: original.allowUsernameChange },
    });

    await request(baseUrl).patch(path).set(user.headers).send(payload).expect(403);
    await request(baseUrl).patch(path).set(moderator.headers).send(payload).expect(403);
    await expect(readSettings()).resolves.toEqual(original);

    await request(baseUrl).patch(path).set(admin.headers).send(payload).expect(200);
    await expect(readSettings()).resolves.toEqual({ ...original, ...payload });
    await expect(readOverHttp(admin)).resolves.toMatchObject({ settings: payload });
  });
});
