import {
  AuthType,
  DataGatewayInterviewFailure,
  LanguageCodeFormat,
  LanguageLinkOrigin,
  LanguageLinkStatus,
  type DataGateway,
  type LanguageGatewayLink,
} from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The DataGateway admin review routes (#715), and the row they return
 * (#753).
 *
 * No coordinator runs here, so DataGateways are seeded disabled, and no test
 * calls a route that would reach the coordinator for an enabled one.
 * DataGateways and their links are swept before each test. Languages and
 * language tags are preserved, so the accept test removes the language it
 * adds, which takes its tag with it.
 */
describe('DataGateway review', () => {
  const baseUrl = requireBaseUrl(process.env);
  const GATEWAYS = '/api/data-gateways';
  const ADDED_LANGUAGE = 'tlh';

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
    await db.client.language.deleteMany({ where: { iso6393: ADDED_LANGUAGE } });
  });

  let seq = 0;
  const seedGateway = (overrides: Partial<DataGateway> = {}) =>
    db.client.dataGateway.create({
      data: {
        name: `Review Gateway ${++seq}`,
        connectionUrl: 'localhost',
        connectionPort: 50099,
        authType: AuthType.None,
        enabled: false,
        authParameters: { apiKey: 'secret' },
        ...overrides,
      } as never,
    });

  const seedLink = (gatewayId: string, overrides: Partial<LanguageGatewayLink> = {}) =>
    db.client.languageGatewayLink.create({
      data: {
        gatewayId,
        value: 'Elvish',
        format: LanguageCodeFormat.Name,
        status: LanguageLinkStatus.Unresolved,
        origin: LanguageLinkOrigin.Interview,
        ...overrides,
      } as never,
    });

  const englishTag = () => db.client.languageTag.findUniqueOrThrow({ where: { tag: 'en' } });

  const FRESH_INTERVIEW = { interviewed: false, firstInterviewedAt: null, lastInterviewedAt: null, failure: null };

  const expectRow = (row: Record<string, unknown>) => {
    expect(row).not.toHaveProperty('authParameters');
    expect(row).toEqual(expect.objectContaining({ hasAuthParameters: true, interview: FRESH_INTERVIEW }));
  };

  describe('the row (#753)', () => {
    it('carries no stored credentials from the list or the by-id read', async () => {
      const gateway = await seedGateway();

      const list = await request(baseUrl).get(GATEWAYS).set(admin.headers).expect(200);
      const one = await request(baseUrl).get(`${GATEWAYS}/${gateway.id}`).set(admin.headers).expect(200);

      expect(list.body.dataGateways).toHaveLength(1);
      expectRow(list.body.dataGateways[0]);
      expectRow(one.body.dataGateway);
    });

    it('carries no stored credentials from create, update or delete', async () => {
      const created = await request(baseUrl)
        .post(GATEWAYS)
        .set(admin.headers)
        .send({
          name: 'Created Gateway',
          connectionUrl: 'localhost',
          connectionPort: 50099,
          authType: AuthType.None,
          enabled: false,
          authParameters: { apiKey: 'secret' },
        })
        .expect(201);
      expectRow(created.body.dataGateway);

      const id = created.body.dataGateway.id;
      const updated = await request(baseUrl)
        .patch(`${GATEWAYS}/${id}`)
        .set(admin.headers)
        .send({ name: 'Renamed Gateway' })
        .expect(200);
      expectRow(updated.body.dataGateway);

      const deleted = await request(baseUrl).delete(`${GATEWAYS}/${id}`).set(admin.headers).expect(200);
      expectRow(deleted.body.dataGateway);
    });

    // #712 writes a section failure with the interview it came with, so the
    // two times are equal, and the failure is still current.
    it('reports a failed section stamped with its interview', async () => {
      const at = new Date('2026-10-01T12:00:00.000Z');
      const gateway = await seedGateway({
        firstInterviewedAt: at,
        lastInterviewedAt: at,
        lastInterviewFailedAt: at,
        lastInterviewFailure: DataGatewayInterviewFailure.LanguageSectionFailed,
      });

      const { body } = await request(baseUrl).get(`${GATEWAYS}/${gateway.id}`).set(admin.headers).expect(200);

      expect(body.dataGateway.interview).toEqual({
        interviewed: true,
        firstInterviewedAt: at.toISOString(),
        lastInterviewedAt: at.toISOString(),
        failure: { code: DataGatewayInterviewFailure.LanguageSectionFailed, at: at.toISOString() },
      });
    });
  });

  describe('capability switches', () => {
    it('stores the list de-duplicated, in enum order', async () => {
      const gateway = await seedGateway();

      const { body } = await request(baseUrl)
        .patch(`${GATEWAYS}/${gateway.id}`)
        .set(admin.headers)
        .send({ disabledCapabilities: ['ListLanguages', 'Search', 'Search'] })
        .expect(200);

      expect(body.dataGateway.disabledCapabilities).toEqual(['Search', 'ListLanguages']);
      const stored = await db.client.dataGateway.findUniqueOrThrow({ where: { id: gateway.id } });
      expect(stored.disabledCapabilities).toEqual(['Search', 'ListLanguages']);
    });

    it('refuses a value that names no capability', async () => {
      const gateway = await seedGateway();

      await request(baseUrl)
        .patch(`${GATEWAYS}/${gateway.id}`)
        .set(admin.headers)
        .send({ disabledCapabilities: ['Bogus'] })
        .expect(400);
    });
  });

  describe('re-interview, refused before the coordinator is asked', () => {
    it('is a 404 for an unknown DataGateway', async () => {
      await request(baseUrl).post(`${GATEWAYS}/no-such-gateway/interview`).set(admin.headers).expect(404);
    });

    it('is a 409 for a disabled DataGateway', async () => {
      const gateway = await seedGateway();

      await request(baseUrl).post(`${GATEWAYS}/${gateway.id}/interview`).set(admin.headers).expect(409);
    });

    it('is a 403 for a plain user', async () => {
      const [gateway, user] = await Promise.all([seedGateway(), actors.user()]);

      await request(baseUrl).post(`${GATEWAYS}/${gateway.id}/interview`).set(user.headers).expect(403);
    });
  });

  describe('the language-link worklist', () => {
    const links = (gatewayId: string) => `${GATEWAYS}/${gatewayId}/language-links`;

    it('lists the Pending and Unresolved links by value, and others when asked', async () => {
      const gateway = await seedGateway();
      const en = await englishTag();
      const [unresolved, pending, , ignored] = await Promise.all([
        seedLink(gateway.id, { value: 'Elvish' }),
        seedLink(gateway.id, {
          value: 'tlh',
          format: LanguageCodeFormat.IetfBcp47,
          status: LanguageLinkStatus.Pending,
        }),
        seedLink(gateway.id, {
          value: 'en',
          format: LanguageCodeFormat.IetfBcp47,
          status: LanguageLinkStatus.Resolved,
          tagId: en.id,
        }),
        seedLink(gateway.id, { value: 'Neutral', status: LanguageLinkStatus.Ignored }),
      ]);

      const { body } = await request(baseUrl).get(links(gateway.id)).set(admin.headers).expect(200);

      expect(body.languageLinks.map((link: { id: string }) => link.id)).toEqual([unresolved.id, pending.id]);
      expect(body.pagination.total).toBe(2);

      const onlyIgnored = await request(baseUrl)
        .get(`${links(gateway.id)}?status=Ignored`)
        .set(admin.headers)
        .expect(200);
      expect(onlyIgnored.body.languageLinks.map((link: { id: string }) => link.id)).toEqual([ignored.id]);
    });

    it('links a link to a tag, and refuses a tag that does not exist', async () => {
      const gateway = await seedGateway();
      const [link, en] = await Promise.all([seedLink(gateway.id), englishTag()]);

      const { body } = await request(baseUrl)
        .post(`${links(gateway.id)}/${link.id}/link`)
        .set(admin.headers)
        .send({ tagId: en.id })
        .expect(200);

      expect(body.languageLink).toEqual(
        expect.objectContaining({ status: LanguageLinkStatus.Resolved, tag: expect.objectContaining({ tag: 'en' }) }),
      );

      await request(baseUrl)
        .post(`${links(gateway.id)}/${link.id}/link`)
        .set(admin.headers)
        .send({ tagId: 'no-such-tag' })
        .expect(400);
    });

    it('ignores a link, dropping its tag', async () => {
      const gateway = await seedGateway();
      const link = await seedLink(gateway.id, { status: LanguageLinkStatus.Pending });

      const { body } = await request(baseUrl)
        .post(`${links(gateway.id)}/${link.id}/ignore`)
        .set(admin.headers)
        .expect(200);

      expect(body.languageLink).toEqual(expect.objectContaining({ status: LanguageLinkStatus.Ignored, tag: null }));
    });

    it('accepts a Pending link, adding its language and tag', async () => {
      await expect(db.client.language.findUnique({ where: { iso6393: ADDED_LANGUAGE } })).resolves.toBeNull();
      await expect(db.client.languageTag.findUnique({ where: { tag: ADDED_LANGUAGE } })).resolves.toBeNull();
      const gateway = await seedGateway();
      const link = await seedLink(gateway.id, {
        value: ADDED_LANGUAGE,
        format: LanguageCodeFormat.IetfBcp47,
        status: LanguageLinkStatus.Pending,
      });

      const { body } = await request(baseUrl)
        .post(`${links(gateway.id)}/${link.id}/accept`)
        .set(admin.headers)
        .expect(200);

      expect(body.languageLink).toEqual(
        expect.objectContaining({
          status: LanguageLinkStatus.Resolved,
          tag: expect.objectContaining({ tag: ADDED_LANGUAGE }),
        }),
      );
      await expect(db.client.languageTag.findUnique({ where: { tag: ADDED_LANGUAGE } })).resolves.toEqual(
        expect.objectContaining({ source: 'Gateway' }),
      );

      // Accepted once, it isn't Pending any more.
      await request(baseUrl)
        .post(`${links(gateway.id)}/${link.id}/accept`)
        .set(admin.headers)
        .expect(409);
    });

    // The supplied tag names the script the ISO code can't.
    it('accepts an ISO value as the tag the DataGateway supplied beside it', async () => {
      const gateway = await seedGateway();
      const link = await seedLink(gateway.id, {
        value: 'zho',
        format: LanguageCodeFormat.Iso6393,
        status: LanguageLinkStatus.Pending,
        suppliedIetfTag: 'zh-Hant',
      });

      const { body } = await request(baseUrl)
        .post(`${links(gateway.id)}/${link.id}/accept`)
        .set(admin.headers)
        .expect(200);

      expect(body.languageLink.tag).toEqual(expect.objectContaining({ tag: 'zh-Hant' }));
    });

    it("is a 404 for another DataGateway's link, and leaves it as it was", async () => {
      const [mine, theirs] = await Promise.all([seedGateway(), seedGateway()]);
      const link = await seedLink(theirs.id);

      for (const action of ['link', 'ignore', 'accept']) {
        await request(baseUrl)
          .post(`${links(mine.id)}/${link.id}/${action}`)
          .set(admin.headers)
          .send({ tagId: (await englishTag()).id })
          .expect(404);
      }

      await expect(db.client.languageGatewayLink.findUniqueOrThrow({ where: { id: link.id } })).resolves.toEqual(
        expect.objectContaining({ status: LanguageLinkStatus.Unresolved, tagId: null }),
      );
    });

    // Links carry no foreign key to their DataGateway, so they outlive it.
    it('is a 404 on every route for a deleted DataGateway, although its links remain', async () => {
      const gateway = await seedGateway({ deletedAt: new Date() });
      const [link, en] = await Promise.all([seedLink(gateway.id), englishTag()]);

      await request(baseUrl).get(links(gateway.id)).set(admin.headers).expect(404);
      for (const action of ['link', 'ignore', 'accept']) {
        await request(baseUrl)
          .post(`${links(gateway.id)}/${link.id}/${action}`)
          .set(admin.headers)
          .send({ tagId: en.id })
          .expect(404);
      }

      await expect(db.client.languageGatewayLink.findUniqueOrThrow({ where: { id: link.id } })).resolves.toEqual(
        expect.objectContaining({ status: LanguageLinkStatus.Unresolved }),
      );
    });

    it('lets a moderator read the worklist but not act on it, and a plain user neither', async () => {
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
});
