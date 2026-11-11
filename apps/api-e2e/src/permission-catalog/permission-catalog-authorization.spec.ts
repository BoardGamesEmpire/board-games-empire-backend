import { PermissionOwner, SystemRole } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { restoreShippedCatalog } from './shipped-catalog';

/**
 * Who may read and edit the permission catalog (#772).
 *
 * No role holds a permission on `Permission`, `Role` or `RolePermission`, so
 * only the Owner's `manage:all` reaches a write. Staff read every resource
 * type through their `read:public_content`, so they read the permission
 * catalog as they read the system settings, and edit none of it. A plain user
 * and an anonymous user reach no route, and an unauthenticated request is
 * refused before any policy is checked.
 *
 * Every route is sent the same request by every caller, one at a time, and
 * the Owner's answers are the control: each request is one the route
 * accepts, so a 403 is about the caller, not about the request. A refused
 * caller writes nothing, which is checked on the tables. The Owner's writes
 * do land, and `afterEach` puts the permission catalog back for the specs
 * after this one.
 */
describe('permission catalog authorization (#772)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PATH = '/api/permission-catalog';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterEach(async () => {
    await restoreShippedCatalog(db.client);
  });

  afterAll(async () => {
    await db.close();
  });

  type Headers = Readonly<Record<string, string>>;

  /**
   * Every route, with a request it accepts from the Owner, in the order they
   * are sent. The grant is one the permission catalog ships, so giving it is
   * answered as it is, and taking it keeps it, revoked. Each hand-back finds
   * the entry an earlier write in the list made the Owner's.
   */
  const ROUTES: readonly (readonly [string, (headers: Headers) => request.Test])[] = [
    ['GET /permission-catalog', (headers) => request(baseUrl).get(PATH).set(headers)],
    [
      'PATCH /permission-catalog/permissions/read:game',
      (headers) =>
        request(baseUrl)
          .patch(`${PATH}/permissions/read:game`)
          .set(headers)
          .send({ reason: 'View the games you made yourself' }),
    ],
    [
      'PATCH /permission-catalog/roles/User',
      (headers) =>
        request(baseUrl)
          .patch(`${PATH}/roles/${SystemRole.User}`)
          .set(headers)
          .send({ description: 'Everyone signed in to this server' }),
    ],
    [
      'PUT /permission-catalog/roles/User/grants/read:game',
      (headers) => request(baseUrl).put(`${PATH}/roles/${SystemRole.User}/grants/read:game`).set(headers),
    ],
    [
      'DELETE /permission-catalog/roles/User/grants/read:game',
      (headers) => request(baseUrl).delete(`${PATH}/roles/${SystemRole.User}/grants/read:game`).set(headers),
    ],
    [
      'POST /permission-catalog/permissions/read:game/hand-back',
      (headers) => request(baseUrl).post(`${PATH}/permissions/read:game/hand-back`).set(headers),
    ],
    [
      'POST /permission-catalog/roles/User/hand-back',
      (headers) => request(baseUrl).post(`${PATH}/roles/${SystemRole.User}/hand-back`).set(headers),
    ],
    [
      'POST /permission-catalog/roles/User/grants/read:game/hand-back',
      (headers) => request(baseUrl).post(`${PATH}/roles/${SystemRole.User}/grants/read:game/hand-back`).set(headers),
    ],
  ];

  const [READ, ...WRITES] = ROUTES.map(([route]) => route);

  /** What every route answers `headers`, by route, sent one after another so no write races another. */
  async function statusesFor(headers: Headers): Promise<Record<string, number>> {
    const statuses: Record<string, number> = {};
    for (const [route, send] of ROUTES) {
      statuses[route] = (await send(headers)).status;
    }

    return statuses;
  }

  const answering = (status: number, routes: readonly string[]) =>
    Object.fromEntries(routes.map((route) => [route, status]));

  /** Entries an edit left the Owner's, or revoked or retired: what a refused caller must not leave behind. */
  const edited = async () => ({
    permissions: await db.client.permission.count({
      where: { OR: [{ managedBy: PermissionOwner.Admin }, { retiredAt: { not: null } }] },
    }),
    roles: await db.client.role.count({ where: { managedBy: PermissionOwner.Admin } }),
    grants: await db.client.rolePermission.count({
      where: { OR: [{ managedBy: PermissionOwner.Admin }, { revokedAt: { not: null } }] },
    }),
  });

  const NOTHING_EDITED = { permissions: 0, roles: 0, grants: 0 };

  it('answers the Owner on every route, so each request below is one the routes accept', async () => {
    const owner = await actors.owner();

    const { body } = await request(baseUrl).get(PATH).set(owner.headers).expect(200);

    expect(body.permissions).toContainEqual(
      expect.objectContaining({ slug: 'manage:all', managedBy: PermissionOwner.System, retiredAt: null, drift: [] }),
    );
    expect(body.roles).toContainEqual(
      expect.objectContaining({
        name: SystemRole.Owner,
        grants: [{ slug: 'manage:all', managedBy: PermissionOwner.System, revokedAt: null, shipped: true }],
      }),
    );

    expect(await statusesFor(owner.headers)).toEqual(answering(200, [READ, ...WRITES]));

    // The writes landed. Each hand-back made its entry the server's again
    // and changed nothing else, so each keeps its edit until the next start.
    expect(
      await db.client.permission.findUniqueOrThrow({
        where: { slug: 'read:game' },
        select: { reason: true, managedBy: true },
      }),
    ).toEqual({ reason: 'View the games you made yourself', managedBy: PermissionOwner.System });
    expect(
      await db.client.role.findUniqueOrThrow({
        where: { name: SystemRole.User },
        select: { description: true, managedBy: true },
      }),
    ).toEqual({ description: 'Everyone signed in to this server', managedBy: PermissionOwner.System });
    expect(
      await db.client.rolePermission.findFirstOrThrow({
        where: { role: { name: SystemRole.User }, permission: { slug: 'read:game' } },
        select: { managedBy: true, revokedAt: true },
      }),
    ).toEqual({ managedBy: PermissionOwner.System, revokedAt: expect.any(Date) });
  });

  it('lets staff read the permission catalog, as they read the system settings, and refuses them every edit', async () => {
    const [admin, moderator] = await Promise.all([actors.admin(), actors.moderator()]);
    const staffAnswers = { ...answering(200, [READ]), ...answering(403, WRITES) };

    // One assertion over both, so a failure shows each role's answers.
    expect({
      admin: await statusesFor(admin.headers),
      moderator: await statusesFor(moderator.headers),
    }).toEqual({ admin: staffAnswers, moderator: staffAnswers });
    expect(await edited()).toEqual(NOTHING_EDITED);
  });

  it('refuses a plain user every route, the read included', async () => {
    const user = await actors.user();

    expect(await statusesFor(user.headers)).toEqual(answering(403, [READ, ...WRITES]));
    expect(await edited()).toEqual(NOTHING_EDITED);
  });

  it('refuses an anonymous user every route, the read included', async () => {
    const anonymous = await actors.anonymous();

    expect(await statusesFor(anonymous.headers)).toEqual(answering(403, [READ, ...WRITES]));
    expect(await edited()).toEqual(NOTHING_EDITED);
  });

  it('answers 401 to an unauthenticated request on every route, before any policy is checked', async () => {
    expect(await statusesFor({})).toEqual(answering(401, [READ, ...WRITES]));
    expect(await edited()).toEqual(NOTHING_EDITED);
  });
});
