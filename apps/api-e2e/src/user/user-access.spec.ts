import { AuthType, ResourceType } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * `GET /api/users/me/access` (#757): what the acting actor may do with each
 * resource type it names, over the real role catalog. Each `none` and `all` on
 * a DataGateway is paired with the route that checks that action, which must
 * refuse the same actor or let it past, so the answer is seen to agree with
 * the server's own checks. No DataGateway route checks `manage`, so its answer
 * stands alone.
 *
 * Actors are made inside each test, because the database is reset before
 * every one. No coordinator runs here, so the DataGateway seeded for the API
 * key is disabled.
 */
describe('user access (#757)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const ACCESS = '/api/users/me/access';
  const GATEWAYS = '/api/data-gateways';

  const ALL = { create: 'all', read: 'all', update: 'all', delete: 'all', manage: 'all' };
  const NONE = { create: 'none', read: 'none', update: 'none', delete: 'none', manage: 'none' };

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  type AuthHeaders = Readonly<Record<string, string>>;

  const accessOf = (headers: AuthHeaders, types: string) =>
    request(baseUrl).get(`${ACCESS}?resourceTypes=${types}`).set(headers);

  // The route that checks each action. The policy check runs before the id is
  // read, so a refusal needs no real DataGateway.
  const ANY_ID = 'no-such-gateway';
  const gatewayRoutes = {
    create: (headers: AuthHeaders) => request(baseUrl).post(GATEWAYS).set(headers).send({}),
    read: (headers: AuthHeaders) => request(baseUrl).get(GATEWAYS).set(headers),
    update: (headers: AuthHeaders) => request(baseUrl).patch(`${GATEWAYS}/${ANY_ID}`).set(headers).send({}),
    delete: (headers: AuthHeaders) => request(baseUrl).delete(`${GATEWAYS}/${ANY_ID}`).set(headers),
  };

  // Each answer is held to the route that checks its action: a `none` is
  // refused there, and an `all` gets past the policy check, so whatever comes
  // back (a 400 for the empty body, a 404 for the made-up id) is not a 403. A
  // `some` depends on the record, so it is pinned by its expected value only.
  const expectRoutesAgree = async (headers: AuthHeaders, answer: Record<string, string>) => {
    for (const [action, route] of Object.entries(gatewayRoutes)) {
      const response = await route(headers);

      if (answer[action] === 'none') {
        expect({ action, status: response.status }).toEqual({ action, status: 403 });
      } else if (answer[action] === 'all') {
        expect({ action, status: response.status }).not.toEqual({ action, status: 403 });
      }
    }
  };

  const seedGateway = () =>
    db.client.dataGateway.create({
      data: {
        name: 'Access Gateway',
        connectionUrl: 'localhost',
        connectionPort: 50099,
        authType: AuthType.None,
        enabled: false,
      } as never,
    });

  it('answers every action all for the Owner, and every route agrees (#757)', async () => {
    const owner = await actors.owner();

    const response = await accessOf(owner.headers, ResourceType.DataGateway).expect(200);

    expect(response.body).toEqual({ access: { DataGateway: ALL } });
    await expectRoutesAgree(owner.headers, response.body.access.DataGateway);
  });

  it('answers Admin all for create, read, update and delete, and none for manage, and every route agrees (#757)', async () => {
    const admin = await actors.admin();

    const response = await accessOf(admin.headers, ResourceType.DataGateway).expect(200);

    expect(response.body.access.DataGateway).toEqual({ ...ALL, manage: 'none' });
    await expectRoutesAgree(admin.headers, response.body.access.DataGateway);
  });

  it('answers Moderator a read and no changes, and every route agrees (#757)', async () => {
    const moderator = await actors.moderator();

    const response = await accessOf(moderator.headers, ResourceType.DataGateway).expect(200);

    expect(response.body.access.DataGateway).toEqual({ ...NONE, read: 'all' });
    await expectRoutesAgree(moderator.headers, response.body.access.DataGateway);
  });

  it('answers a user with only the base role none for DataGateways, and every route agrees (#757)', async () => {
    const user = await actors.user();

    const response = await accessOf(user.headers, ResourceType.DataGateway).expect(200);

    expect(response.body.access.DataGateway).toEqual(NONE);
    await expectRoutesAgree(user.headers, response.body.access.DataGateway);
  });

  it('answers a user with only the base role some for updating profiles, since the grant reaches only their own (#757)', async () => {
    const user = await actors.user();

    const response = await accessOf(user.headers, ResourceType.UserProfile).expect(200);

    expect(response.body.access.UserProfile.update).toBe('some');
  });

  it('narrows an API key to its key scopes, and the routes agree (#757)', async () => {
    const admin = await actors.admin();
    const gateway = await seedGateway();
    // The roles above answer create and delete alike, so a route checking the
    // other of the two would agree with them all. This key holds create without
    // delete, so the two routes must disagree here (#757).
    const key = await mintApiKey(baseUrl, db.client, admin, [
      { slugs: ['create:data_gateway'], resourceType: ResourceType.DataGateway },
      { slugs: ['read:data_gateway'], resourceType: ResourceType.DataGateway },
      { slugs: ['update:data_gateway'], resourceType: ResourceType.DataGateway, resourceId: gateway.id },
    ]);

    const response = await accessOf(key.headers, ResourceType.DataGateway).expect(200);

    expect(response.body.access.DataGateway).toEqual({ ...NONE, create: 'all', read: 'all', update: 'some' });
    await expectRoutesAgree(key.headers, response.body.access.DataGateway);
  });

  it('answers a key with no key scopes none everywhere, whoever owns it, and every route agrees (#757)', async () => {
    const owner = await actors.owner();
    const key = await mintApiKey(baseUrl, db.client, owner);

    const response = await accessOf(key.headers, ResourceType.DataGateway).expect(200);

    expect(response.body.access.DataGateway).toEqual(NONE);
    await expectRoutesAgree(key.headers, response.body.access.DataGateway);
  });

  it('answers each named resource type once, comma-separated or repeated (#757)', async () => {
    const user = await actors.user();

    const response = await accessOf(user.headers, 'DataGateway,DataGateway&resourceTypes=UserProfile').expect(200);

    expect(Object.keys(response.body.access)).toEqual([ResourceType.DataGateway, ResourceType.UserProfile]);
  });

  it('is never cached (#757)', async () => {
    const user = await actors.user();

    const response = await accessOf(user.headers, ResourceType.DataGateway).expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a missing, empty or unknown list (#757)', async () => {
    const user = await actors.user();

    await request(baseUrl).get(ACCESS).set(user.headers).expect(400);
    await accessOf(user.headers, '').expect(400);
    await accessOf(user.headers, 'NotAType').expect(400);
  });

  it('refuses a request with no session (#757)', async () => {
    await request(baseUrl).get(`${ACCESS}?resourceTypes=${ResourceType.DataGateway}`).expect(401);
  });
});
