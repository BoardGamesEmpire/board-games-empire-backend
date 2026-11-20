import type { Prisma } from '@bge/database';
import { AuthType, DataGatewayCapability, ResourceType, Upstream } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

/**
 * Linking a BoardGameGeek account by username, on the wire (#1226): which
 * DataGateways make BoardGameGeek linkable, and every way the link refuses.
 *
 * No coordinator runs in this harness, so a link that gets as far as the
 * lookup finds nothing to ask, and answers as an unreachable BoardGameGeek
 * does. A found username, through the coordinator to a DataGateway, is
 * covered by the coordinator's e2e and by the link service's unit specs.
 * The DataGateway rows are seeded straight into the database: nothing
 * connects to them.
 */
describe('linking a BoardGameGeek account (#1226)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const LIST = '/api/users/me/upstream-accounts';
  const LINK = `${LIST}/boardgamegeek`;

  /** A remote DataGateway's connection fields; nothing connects to them here. */
  const CONNECTION = { connectionUrl: 'localhost', connectionPort: 50099, authType: AuthType.None } as const;

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  let seq = 0;

  /** An enabled DataGateway declaring BoardGameGeek, serving the lookup a link makes unless `data` says otherwise. */
  const seedBggDataGateway = (data: Partial<Prisma.DataGatewayUncheckedCreateInput> = {}) =>
    db.client.dataGateway.create({
      data: {
        name: `BoardGameGeek Gateway ${++seq}`,
        upstream: Upstream.BoardGameGeek,
        enabled: true,
        capabilities: [DataGatewayCapability.Search, DataGatewayCapability.FindUpstreamAccount],
        ...CONNECTION,
        ...data,
      },
    });

  const link = (headers: Readonly<Record<string, string>>, username: unknown = 'BGFan') =>
    request(baseUrl).post(LINK).set(headers).send({ username });

  const linkable = async (user: SessionActor): Promise<string[]> =>
    (await request(baseUrl).get(LIST).set(user.headers).expect(200)).body.linkableUpstreams;

  // The list tells a client which upstreams to offer a link for, so it offers
  // BoardGameGeek only where the link's lookup can be asked (#1226).
  it('lists BoardGameGeek only for a DataGateway that serves the lookup, and refuses the link without one', async () => {
    const user = await actors.user();

    // No DataGateway declares BoardGameGeek.
    expectErrorEnvelope(await link(user.headers), { status: 409, code: 'UPSTREAM_NOT_LINKABLE' });

    // One declares it, but doesn't serve the lookup; another serves it, but an
    // admin switched it off; a third serves it, but is disabled.
    await seedBggDataGateway({ capabilities: [DataGatewayCapability.Search] });
    await seedBggDataGateway({ disabledCapabilities: [DataGatewayCapability.FindUpstreamAccount] });
    const disabled = await seedBggDataGateway({ enabled: false });

    await expect(linkable(user)).resolves.toEqual([]);
    expectErrorEnvelope(await link(user.headers), { status: 409, code: 'UPSTREAM_NOT_LINKABLE' });

    // The control: the same row, enabled, makes BoardGameGeek linkable.
    await db.client.dataGateway.update({ where: { id: disabled.id }, data: { enabled: true } });

    await expect(linkable(user)).resolves.toEqual(['boardgamegeek']);
    await expect(db.client.upstreamAccount.count({ where: { userId: user.user.id } })).resolves.toBe(0);
  });

  // The user is told the lookup failed, never a 500, and nothing is stored.
  it('answers UPSTREAM_UNREACHABLE when the lookup has no coordinator to ask (#1226)', async () => {
    const user = await actors.user();
    await seedBggDataGateway();

    expectErrorEnvelope(await link(user.headers), { status: 503, code: 'UPSTREAM_UNREACHABLE' });
    await expect(db.client.upstreamAccount.count({ where: { userId: user.user.id } })).resolves.toBe(0);
  });

  it('answers UPSTREAM_ACCOUNT_ALREADY_LINKED to a user who has a BoardGameGeek account, asking no one (#1226)', async () => {
    const user = await actors.user();
    await seedBggDataGateway();
    await db.client.upstreamAccount.create({
      data: { userId: user.user.id, upstream: Upstream.BoardGameGeek, externalId: 'BGFan', verified: false },
    });

    // Refused before the lookup, so the missing coordinator isn't reached.
    expectErrorEnvelope(await link(user.headers, 'SomeoneElse'), {
      status: 409,
      code: 'UPSTREAM_ACCOUNT_ALREADY_LINKED',
    });
  });

  it('refuses an empty username, an API key, an anonymous user and someone not signed in (#1226)', async () => {
    const user = await actors.user();
    await seedBggDataGateway();

    expectErrorEnvelope(await link(user.headers, '   '), { status: 400, code: null });

    // An API key acts for its owner but is not the owner. This one holds the
    // grants to read and link the owner's upstream accounts; the list
    // answering it shows the key works. That the 403 is the route's own
    // refusal of a key, past the permission check, is pinned by the
    // controller's unit spec.
    const key = await mintApiKey(baseUrl, db.client, user, {
      resourceType: ResourceType.UpstreamAccount,
      slugs: ['create:upstream_account:own', 'read:upstream_account:own'],
    });
    await request(baseUrl).get(LIST).set(key.headers).expect(200);
    await link(key.headers).expect(403);

    const anonymous = await actors.anonymous();
    await link(anonymous.headers).expect(403);
    expectErrorEnvelope(await link({}), { status: 401, code: 'UNAUTHORIZED' });

    // The control: the same user's own session gets past every check to the
    // lookup, which this harness can't answer.
    expectErrorEnvelope(await link(user.headers), { status: 503, code: 'UPSTREAM_UNREACHABLE' });
    await expect(db.client.upstreamAccount.count({ where: { userId: user.user.id } })).resolves.toBe(0);
  });
});
