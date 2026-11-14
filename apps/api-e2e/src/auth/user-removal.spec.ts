import { USER_REMOVAL_BLOCKERS } from '@bge/auth';
import { EventParticipationStatus, GameAdditionMode, ResourceType } from '@bge/database';
import { createActors, prepareSignup, SIGN_UP_EMAIL_PATH, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangeListEntry } from '../event/event-fixtures';
import { createEventClient, EVENTS_PATH } from '../event/event-request';
import { createEnvelope } from '../household/household-wire';
import { mintApiKey } from '../support/api-key';
import { postToAuth, signInAgain } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const REMOVE_USER_PATH = '/api/auth/admin/remove-user';
const DELETE_ANONYMOUS_USER_PATH = '/api/auth/delete-anonymous-user';
const SIGN_IN_EMAIL_PATH = '/api/auth/sign-in/email';
const GET_SESSION_PATH = '/api/auth/get-session';
const HOUSEHOLDS_PATH = '/api/households';

/**
 * Removing a user removes them completely or changes nothing (#1054).
 *
 * better-auth deletes a user's sessions, then their sign-in methods (its
 * account rows), then the user row, with no transaction around them. The
 * user's private rows go with the user row by foreign-key rules, so that last
 * delete is one atomic step. The same delete serves the anonymous plugin,
 * which removes an anonymous user on request and once they sign up. Each
 * removal is sent as the Owner, signed in again: on the signup session every
 * better-auth admin route refuses for its own reasons (see `signInAgain`).
 */
describe('removing a user', () => {
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

  const { createdEventId } = createEventClient(baseUrl);

  const ownerHeaders = async (): Promise<{ readonly Authorization: string }> =>
    signInAgain(baseUrl, await actors.owner());

  const createHousehold = async (founder: SessionActor): Promise<string> =>
    createEnvelope(
      await request(baseUrl).post(HOUSEHOLDS_PATH).set(founder.headers).send({ name: 'Shared household' }).expect(201),
      'POST /api/households',
    ).household.id;

  const signInWithPassword = (actor: SessionActor) =>
    postToAuth(baseUrl, SIGN_IN_EMAIL_PATH).send({ email: actor.user.email, password: actor.password });

  it('removes a provisioned user completely (#1054)', async () => {
    const headers = await ownerHeaders();
    const target = await actors.user();
    const userId = target.user.id;
    // A custom list needs a name (#1241).
    await db.client.list.create({ data: { userId, name: 'Weekend picks' } });
    await mintApiKey(baseUrl, db.client, target);

    const response = await postToAuth(baseUrl, REMOVE_USER_PATH).set(headers).send({ userId });

    expect(response.status).toBe(200);
    await expect(
      Promise.all([
        db.client.user.count({ where: { id: userId } }),
        db.client.userPreferences.count({ where: { userId } }),
        db.client.userProfile.count({ where: { userId } }),
        db.client.userRole.count({ where: { userId } }),
        db.client.account.count({ where: { userId } }),
        db.client.list.count({ where: { userId } }),
        db.client.apikey.count({ where: { referenceId: userId } }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);

    const signIn = await signInWithPassword(target);
    expect(signIn.status).toBe(401);
  });

  // Removing a user who shares data isn't supported yet (#1277), so the route
  // refuses before any sign-in method goes. It has signed the user out by then.
  it("refuses to remove a household's founder, and changes nothing but their sessions (#1054)", async () => {
    const headers = await ownerHeaders();
    const target = await actors.user();
    const userId = target.user.id;
    const householdId = await createHousehold(target);

    const response = await postToAuth(baseUrl, REMOVE_USER_PATH).set(headers).send({ userId });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'USER_REMOVAL_BLOCKED' });
    await expect(
      Promise.all([
        db.client.user.count({ where: { id: userId } }),
        db.client.account.count({ where: { userId } }),
        db.client.household.count({ where: { id: householdId } }),
      ]),
    ).resolves.toEqual([1, 1, 1]);

    const oldSession = await request(baseUrl).get(GET_SESSION_PATH).set(target.headers);
    expect(oldSession.status).toBe(200);
    expect(oldSession.body).toBeNull();

    const signIn = await signInWithPassword(target);
    expect(signIn.status).toBe(200);
  });

  // Postgres refuses the delete for any row that names the user, deleted or
  // not, so the check ignores soft-delete flags (#1054).
  it('still refuses after the household is deleted, because its row remains (#1054)', async () => {
    const headers = await ownerHeaders();
    const target = await actors.user();
    const householdId = await createHousehold(target);
    await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${householdId}`).set(target.headers).expect(200);

    const response = await postToAuth(baseUrl, REMOVE_USER_PATH).set(headers).send({ userId: target.user.id });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'USER_REMOVAL_BLOCKED' });
  });

  // A grant the user made to themselves cascades with them on `user_id`, but
  // the older `granted_by_id` key's RESTRICT check runs before that cascade,
  // so Postgres refuses the delete. Were the gate to skip self-grants, this
  // would answer 500 with the sign-in methods gone (#1054).
  it('refuses to remove a user who granted a permission to themselves, as Postgres does (#1054)', async () => {
    const headers = await ownerHeaders();
    const target = await actors.user();
    const userId = target.user.id;
    const permission = await db.client.permission.findFirstOrThrow({ select: { id: true } });
    await db.client.userPermission.create({
      data: {
        userId,
        grantedById: userId,
        permissionId: permission.id,
        resourceType: ResourceType.Household,
        resourceId: 'self-granted',
      },
    });

    const response = await postToAuth(baseUrl, REMOVE_USER_PATH).set(headers).send({ userId });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'USER_REMOVAL_BLOCKED' });
    await expect(
      Promise.all([db.client.user.count({ where: { id: userId } }), db.client.account.count({ where: { userId } })]),
    ).resolves.toEqual([1, 1]);
  });

  // The user's game collection goes with them, and the games they offered on
  // another user's event with it. A scheduled or nominated game still names
  // its offer, so Postgres refuses there, a step past the user row: the user
  // shares that game with the event, and the removal is refused before any
  // sign-in method goes (#1054).
  it.each([
    [
      'scheduled',
      async (eventId: string, entry: { platformGameId: string; suppliedById: string }) => {
        await db.client.eventGame.create({
          data: { eventId, platformGameId: entry.platformGameId, suppliedById: entry.suppliedById },
        });
      },
    ],
    [
      'nominated',
      async (eventId: string, entry: { platformGameId: string; suppliedById: string }, host: SessionActor) => {
        await request(baseUrl)
          .post(`${EVENTS_PATH}/${eventId}/nominations`)
          .set(host.headers)
          .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById })
          .expect(201);
      },
    ],
  ])("refuses to remove a user whose game is %s on another user's event (#1054)", async (_, offer) => {
    const headers = await ownerHeaders();
    const host = await actors.user();
    const target = await actors.user();
    const userId = target.user.id;
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.RequiresVote } });
    await request(baseUrl)
      .post(`${EVENTS_PATH}/${eventId}/attendees`)
      .set(host.headers)
      .send({ userId, status: EventParticipationStatus.Attending })
      .expect(201);
    await offer(eventId, await arrangeListEntry(db.client, eventId, userId), host);

    const response = await postToAuth(baseUrl, REMOVE_USER_PATH).set(headers).send({ userId });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'USER_REMOVAL_BLOCKED' });
    await expect(
      Promise.all([db.client.user.count({ where: { id: userId } }), db.client.account.count({ where: { userId } })]),
    ).resolves.toEqual([1, 1]);
  });

  // A required relation added later with no delete rule, to User or to a
  // table that cascades from it, would refuse the user row's delete after the
  // sign-in methods had gone. This fails first: the new key must cascade, or
  // join the list (#1054).
  it("lists exactly the foreign keys that refuse a user's delete, directly or past a cascade (#1054)", async () => {
    // `doomed` is every table a user's delete reaches: users, and each table
    // that cascades from one already in it. Bound to `db.schema`, not
    // `current_schema()`: raw SQL runs against the connection default, which
    // is not the schema under the `?schema=` escape hatch.
    const rows = await db.client.$queryRaw<{ table: string; column: string }[]>`
      WITH RECURSIVE doomed(oid) AS (
        SELECT users.oid
        FROM pg_class users
        JOIN pg_namespace users_schema ON users_schema.oid = users.relnamespace
        WHERE users.relname = 'users' AND users_schema.nspname = ${db.schema}
        UNION
        SELECT fk.conrelid
        FROM pg_constraint fk
        JOIN doomed ON fk.confrelid = doomed.oid
        WHERE fk.contype = 'f' AND fk.confdeltype = 'c'
      )
      SELECT DISTINCT referencing.relname::text AS "table", attribute.attname::text AS "column"
      FROM pg_constraint fk
      JOIN pg_class referencing ON referencing.oid = fk.conrelid
      JOIN pg_attribute attribute ON attribute.attrelid = fk.conrelid AND attribute.attnum = ANY (fk.conkey)
      WHERE fk.contype = 'f'
        AND fk.confdeltype IN ('r', 'a')
        AND fk.confrelid IN (SELECT oid FROM doomed)
    `;

    expect(rows.map(({ table, column }) => `${table}.${column}`).sort()).toEqual(
      USER_REMOVAL_BLOCKERS.map(({ table, column }) => `${table}.${column}`).sort(),
    );
  });

  it('deletes an anonymous user through /delete-anonymous-user (#1054)', async () => {
    const anonymousUser = await actors.anonymous();

    const response = await postToAuth(baseUrl, DELETE_ANONYMOUS_USER_PATH).set(anonymousUser.headers).send({});

    expect(response.status).toBe(200);
    await expect(db.client.user.count({ where: { id: anonymousUser.user.id } })).resolves.toBe(0);
  });

  it('removes the anonymous user once they sign up (#1054)', async () => {
    const anonymousUser = await actors.anonymous();
    const { body, email } = prepareSignup();

    const response = await postToAuth(baseUrl, SIGN_UP_EMAIL_PATH).set(anonymousUser.headers).send(body);

    expect(response.status).toBe(200);
    await expect(db.client.user.count({ where: { id: anonymousUser.user.id } })).resolves.toBe(0);
    await expect(db.client.user.count({ where: { email } })).resolves.toBe(1);
  });
});
