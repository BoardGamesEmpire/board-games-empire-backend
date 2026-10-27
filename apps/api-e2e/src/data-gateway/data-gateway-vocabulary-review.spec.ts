import { AuthType, PlatformType, VocabularyLinkOrigin, VocabularyLinkStatus, type DataGateway } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/** Every record and supplied name this spec makes starts so, so `afterEach` can find the platforms it added. */
const PREFIX = 'E2E Vocab';
const SLUG_PREFIX = 'e2e-vocab-';

type Kind = 'platform' | 'category' | 'mechanic';

interface LinkSeed {
  externalId?: string;
  status?: VocabularyLinkStatus;
  suppliedName?: string;
  recordId?: string | null;
}

/**
 * The DataGateway admin review routes for platform, category and mechanic
 * links (#715, #718), one `describe` per kind.
 *
 * No coordinator runs here, so DataGateways are seeded disabled. DataGateways,
 * their links, categories and mechanics are swept before each test, but
 * platforms are preserved, so `afterEach` removes the platforms a test added,
 * which takes their links with them.
 */
describe.each(['platform', 'category', 'mechanic'] as const)('DataGateway %s link review', (kind: Kind) => {
  const baseUrl = requireBaseUrl(process.env);
  const GATEWAYS = '/api/data-gateways';
  const links = (gatewayId: string) => `${GATEWAYS}/${gatewayId}/${kind}-links`;
  const listKey = `${kind}Links`;
  const linkKey = `${kind}Link`;

  let db: TestDatabase;
  let actors: Actors;
  let admin: SessionActor;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    admin = await actors.admin();
  });

  afterEach(async () => {
    await db.client.platform.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  });

  let seq = 0;
  const seedGateway = (overrides: Partial<DataGateway> = {}) =>
    db.client.dataGateway.create({
      data: {
        name: `Vocabulary Review Gateway ${++seq}`,
        connectionUrl: 'localhost',
        connectionPort: 50099,
        authType: AuthType.None,
        enabled: false,
        ...overrides,
      } as never,
    });

  /** A record of this kind, named `${PREFIX} <name>`. */
  const seedRecord = async (name: string): Promise<{ id: string }> => {
    const fullName = `${PREFIX} ${kind} ${name}`;
    const slug = `${SLUG_PREFIX}${kind}-${name}`.toLowerCase();
    const select = { id: true } as const;

    switch (kind) {
      case 'platform':
        return db.client.platform.create({
          data: { name: fullName, slug, platformType: PlatformType.Console },
          select,
        });
      case 'category':
        return db.client.category.create({ data: { name: fullName, slug }, select });
      case 'mechanic':
        return db.client.mechanic.create({ data: { name: fullName, slug }, select });
    }
  };

  const seedLink = async (gatewayId: string, seed: LinkSeed = {}): Promise<{ id: string }> => {
    const common = {
      gatewayId,
      externalId: seed.externalId ?? `ext-${++seq}`,
      status: seed.status ?? VocabularyLinkStatus.Pending,
      origin: VocabularyLinkOrigin.Interview,
      suppliedName: seed.suppliedName ?? `${PREFIX} ${kind} supplied ${seq}`,
    };
    const recordId = seed.recordId ?? null;
    const select = { id: true } as const;

    switch (kind) {
      case 'platform':
        return db.client.platformGatewayLink.create({
          data: {
            ...common,
            platformId: recordId,
            suppliedAbbreviation: 'EVP',
            suppliedPlatformType: PlatformType.Portable,
          },
          select,
        });
      case 'category':
        return db.client.categoryGatewayLink.create({ data: { ...common, categoryId: recordId }, select });
      case 'mechanic':
        return db.client.mechanicGatewayLink.create({ data: { ...common, mechanicId: recordId }, select });
    }
  };

  /** The link as stored: its status and record. */
  const storedLink = async (linkId: string): Promise<{ status: VocabularyLinkStatus; recordId: string | null }> => {
    switch (kind) {
      case 'platform': {
        const row = await db.client.platformGatewayLink.findUniqueOrThrow({ where: { id: linkId } });
        return { status: row.status, recordId: row.platformId };
      }
      case 'category': {
        const row = await db.client.categoryGatewayLink.findUniqueOrThrow({ where: { id: linkId } });
        return { status: row.status, recordId: row.categoryId };
      }
      case 'mechanic': {
        const row = await db.client.mechanicGatewayLink.findUniqueOrThrow({ where: { id: linkId } });
        return { status: row.status, recordId: row.mechanicId };
      }
    }
  };

  const ids = (body: Record<string, Array<{ id: string }>>) => body[listKey].map((link) => link.id);

  it('lists the Pending links by default, and others when asked', async () => {
    const gateway = await seedGateway();
    const record = await seedRecord('listed');
    const [later, earlier, resolved, ignored] = await Promise.all([
      seedLink(gateway.id, { suppliedName: `${PREFIX} ${kind} b` }),
      seedLink(gateway.id, { suppliedName: `${PREFIX} ${kind} a` }),
      seedLink(gateway.id, { status: VocabularyLinkStatus.Resolved, recordId: record.id }),
      seedLink(gateway.id, { status: VocabularyLinkStatus.Ignored }),
    ]);

    const { body } = await request(baseUrl).get(links(gateway.id)).set(admin.headers).expect(200);

    // By the name the DataGateway sent.
    expect(ids(body)).toEqual([earlier.id, later.id]);
    expect(body.pagination.total).toBe(2);

    const settled = await request(baseUrl)
      .get(`${links(gateway.id)}?status=Resolved,Ignored`)
      .set(admin.headers)
      .expect(200);
    expect(new Set(ids(settled.body))).toEqual(new Set([resolved.id, ignored.id]));
    expect(settled.body[listKey].find((link: { id: string }) => link.id === resolved.id)).toEqual(
      expect.objectContaining({
        status: VocabularyLinkStatus.Resolved,
        record: { id: record.id, name: `${PREFIX} ${kind} listed`, slug: `${SLUG_PREFIX}${kind}-listed` },
      }),
    );
  });

  it('links a link to a record, and answers 400 for a record that does not exist', async () => {
    const gateway = await seedGateway();
    const [link, record] = await Promise.all([seedLink(gateway.id), seedRecord('linked')]);

    const { body } = await request(baseUrl)
      .post(`${links(gateway.id)}/${link.id}/link`)
      .set(admin.headers)
      .send({ recordId: record.id })
      .expect(200);

    expect(body[linkKey]).toEqual(
      expect.objectContaining({
        status: VocabularyLinkStatus.Resolved,
        record: expect.objectContaining({ id: record.id }),
      }),
    );

    await request(baseUrl)
      .post(`${links(gateway.id)}/${link.id}/link`)
      .set(admin.headers)
      .send({ recordId: 'no-such-record' })
      .expect(400);
    await expect(storedLink(link.id)).resolves.toEqual({ status: VocabularyLinkStatus.Resolved, recordId: record.id });
  });

  it('ignores a link, dropping its record', async () => {
    const gateway = await seedGateway();
    const record = await seedRecord('ignored');
    const link = await seedLink(gateway.id, { status: VocabularyLinkStatus.Resolved, recordId: record.id });

    const { body } = await request(baseUrl)
      .post(`${links(gateway.id)}/${link.id}/ignore`)
      .set(admin.headers)
      .expect(200);

    expect(body[linkKey]).toEqual(expect.objectContaining({ status: VocabularyLinkStatus.Ignored, record: null }));
    await expect(storedLink(link.id)).resolves.toEqual({ status: VocabularyLinkStatus.Ignored, recordId: null });
  });

  it('accepts a Pending link by adding its record from what the DataGateway sent, and answers 409 for one that is not Pending', async () => {
    const gateway = await seedGateway();
    const suppliedName = `${PREFIX} ${kind} accepted`;
    const link = await seedLink(gateway.id, { suppliedName });

    const { body } = await request(baseUrl)
      .post(`${links(gateway.id)}/${link.id}/accept`)
      .set(admin.headers)
      .expect(200);

    const slug = `${SLUG_PREFIX}${kind}-accepted`;
    expect(body[linkKey]).toEqual(
      expect.objectContaining({
        status: VocabularyLinkStatus.Resolved,
        record: { id: expect.any(String), name: suppliedName, slug },
      }),
    );
    if (kind === 'platform') {
      await expect(db.client.platform.findUniqueOrThrow({ where: { slug } })).resolves.toEqual(
        expect.objectContaining({ abbreviation: 'EVP', platformType: PlatformType.Portable }),
      );
    }

    // Accepted once, it isn't Pending any more.
    await request(baseUrl)
      .post(`${links(gateway.id)}/${link.id}/accept`)
      .set(admin.headers)
      .expect(409);
  });

  it("is a 404 for another DataGateway's link, and leaves it as it was", async () => {
    const [mine, theirs] = await Promise.all([seedGateway(), seedGateway()]);
    const [link, record] = await Promise.all([seedLink(theirs.id), seedRecord('theirs')]);

    for (const action of ['link', 'ignore', 'accept']) {
      await request(baseUrl)
        .post(`${links(mine.id)}/${link.id}/${action}`)
        .set(admin.headers)
        .send({ recordId: record.id })
        .expect(404);
    }

    await expect(storedLink(link.id)).resolves.toEqual({ status: VocabularyLinkStatus.Pending, recordId: null });
  });

  // Links carry no foreign key to their DataGateway, so they outlive it.
  it('is a 404 on every route for a deleted DataGateway, although its links remain', async () => {
    const gateway = await seedGateway({ deletedAt: new Date() });
    const [link, record] = await Promise.all([seedLink(gateway.id), seedRecord('deleted')]);

    await request(baseUrl).get(links(gateway.id)).set(admin.headers).expect(404);
    for (const action of ['link', 'ignore', 'accept']) {
      await request(baseUrl)
        .post(`${links(gateway.id)}/${link.id}/${action}`)
        .set(admin.headers)
        .send({ recordId: record.id })
        .expect(404);
    }

    await expect(storedLink(link.id)).resolves.toEqual({ status: VocabularyLinkStatus.Pending, recordId: null });
  });

  it('lets a moderator read the list but not act on it, and a plain user neither', async () => {
    const gateway = await seedGateway();
    const [link, moderator, user] = await Promise.all([seedLink(gateway.id), actors.moderator(), actors.user()]);

    await request(baseUrl).get(links(gateway.id)).set(moderator.headers).expect(200);
    await request(baseUrl)
      .post(`${links(gateway.id)}/${link.id}/ignore`)
      .set(moderator.headers)
      .expect(403);

    await request(baseUrl).get(links(gateway.id)).set(user.headers).expect(403);
    await request(baseUrl)
      .post(`${links(gateway.id)}/${link.id}/ignore`)
      .set(user.headers)
      .expect(403);
  });
});
