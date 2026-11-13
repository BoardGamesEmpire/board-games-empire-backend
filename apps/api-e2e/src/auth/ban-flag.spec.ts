import { createActors, prepareSignup, type Actors } from '@bge/testing-e2e';
import { postToAuth, signInAgain } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const ADMIN_UPDATE_USER_PATH = '/api/auth/admin/update-user';
const ADMIN_CREATE_USER_PATH = '/api/auth/admin/create-user';
const BAN_USER_PATH = '/api/auth/admin/ban-user';
const UNBAN_USER_PATH = '/api/auth/admin/unban-user';

/**
 * A user's ban flag is `true` or `false`, and nothing else is written (#893).
 *
 * The column refuses NULL, and better-auth's admin create-user and
 * update-user pass their `data` to the database unchecked, so the ban-flag
 * gate in the user hooks refuses any other value with a code before the
 * write. Each request is sent as the Owner, signed in again: on the signup
 * session every better-auth admin route refuses for its own reasons (see
 * `signInAgain`).
 */
describe('the ban flag', () => {
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

  const ownerHeaders = async (): Promise<{ readonly Authorization: string }> =>
    signInAgain(baseUrl, await actors.owner());

  const bannedFlagOf = async (id: string): Promise<boolean> =>
    (await db.client.user.findUniqueOrThrow({ where: { id }, select: { banned: true } })).banned;

  it('refuses update-user with banned: null, and the flag stays false (#893)', async () => {
    const headers = await ownerHeaders();
    const target = await actors.user();

    const response = await postToAuth(baseUrl, ADMIN_UPDATE_USER_PATH)
      .set(headers)
      .send({ userId: target.user.id, data: { banned: null } });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'BAN_FLAG_INVALID' });
    await expect(bannedFlagOf(target.user.id)).resolves.toBe(false);
  });

  it('refuses create-user with banned: "yes" and writes no user (#893)', async () => {
    const headers = await ownerHeaders();
    const { body, email } = prepareSignup();

    const response = await postToAuth(baseUrl, ADMIN_CREATE_USER_PATH)
      .set(headers)
      .send({ email, password: body.password, name: body.name, data: { banned: 'yes' } });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'BAN_FLAG_INVALID' });
    await expect(db.client.user.count({ where: { email } })).resolves.toBe(0);
  });

  it('still bans and unbans through better-auth after the column refuses NULL (#893)', async () => {
    const headers = await ownerHeaders();
    const target = await actors.user();

    const ban = await postToAuth(baseUrl, BAN_USER_PATH).set(headers).send({ userId: target.user.id });

    expect(ban.status).toBe(200);
    await expect(bannedFlagOf(target.user.id)).resolves.toBe(true);

    const unban = await postToAuth(baseUrl, UNBAN_USER_PATH).set(headers).send({ userId: target.user.id });

    expect(unban.status).toBe(200);
    await expect(bannedFlagOf(target.user.id)).resolves.toBe(false);
  });
});
