import { ResourceType } from '@bge/database';
import type { Actors } from '@bge/testing-e2e';
import { createActors, pollUntil } from '@bge/testing-e2e';
import type { Response } from 'supertest';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

/**
 * The privacy policy on the wire (#934): anyone reads it, signed in or not,
 * found through the bge-identity document; a server admin replaces or removes
 * it in one language, and nobody else may. Each write is audited.
 *
 * Every read here is unauthenticated, with no cookie and no API key, so it
 * passes through the api's global auth guard as someone who is not signed in
 * does.
 *
 * The between-test sweep empties `privacy_policies`, so each test starts from
 * the standard privacy policy alone, in English, the one file the api ships.
 */
describe('privacy policy (#934)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PATH = '/api/privacy-policy';
  const GERMAN_PATH = `${PATH}/de`;

  /**
   * A server admin's German text. It has nothing for the sanitizer to remove,
   * so the server stores and serves it exactly as sent.
   */
  const GERMAN = '# Datenschutzerklärung\n\nDieser Server speichert nur, was Ihr Konto braucht.\n';

  /** The audit listener writes after the response; generous for a loaded CI runner. */
  const AUDIT_ROW_LANDS_MS = 5_000;

  const REPLACED = 'privacy_policy.replaced';
  const REMOVED = 'privacy_policy.removed';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** Reads the policy as someone who is not signed in. */
  const readUnauthenticated = async (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    request(baseUrl).get(PATH).query(query).set(headers).expect(200);

  /** The header names a response's `Vary` lists, in lower case. */
  const varyNames = (response: Response): string[] =>
    String(response.headers['vary'] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase());

  /** A privacy policy row's audit entries, oldest first, once one for `event` has been written. */
  const auditEntriesOnceOneIs = (subjectId: string, event: string) =>
    pollUntil(
      async () => {
        const entries = await db.client.auditLog.findMany({
          where: { subject: ResourceType.PrivacyPolicy, subjectId },
          orderBy: { occurredAt: 'asc' },
        });

        return entries.some((entry) => entry.event === event) ? entries : undefined;
      },
      { description: `the ${event} audit entry for privacy policy ${subjectId}`, timeoutMs: AUDIT_ROW_LANDS_MS },
    );

  it('serves the standard policy to someone who is not signed in, found through bge-identity', async () => {
    const identity = await request(baseUrl).get('/.well-known/bge-identity').expect(200);
    const pointer = identity.body.bge_privacy_policy_endpoint;

    expect(pointer).toBe(PATH);

    const response = await request(baseUrl).get(pointer).expect(200);

    expect(response.headers['content-language']).toBe('en');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(varyNames(response)).toContain('accept-language');
    // Exactly the five fields: an editor id, a file path or a hash beside
    // them fails here.
    expect(response.body).toEqual({
      privacyPolicy: {
        availableLanguages: ['en'],
        language: 'en',
        // The text starts at its first heading: the front matter is not served.
        markdown: expect.stringMatching(/^# \S/),
        source: 'standard',
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/),
      },
    });
  });

  it('lets an Admin replace a language and read the change back at once, and refuses a Moderator and a User', async () => {
    const [admin, moderator, user] = await Promise.all([actors.admin(), actors.moderator(), actors.user()]);
    const put = (headers: Record<string, string>) =>
      request(baseUrl).put(GERMAN_PATH).set(headers).send({ markdown: GERMAN });
    const remove = (headers: Record<string, string>) => request(baseUrl).delete(GERMAN_PATH).set(headers);

    // Read before the write, as a reader would. A cache would keep this answer
    // and repeat it after the write, failing the reads below; without this
    // read, they would pass even if the route were served from a cache.
    await expect(readUnauthenticated({ lang: 'de' })).resolves.toMatchObject({
      body: { privacyPolicy: { language: 'en', source: 'standard' } },
    });
    await expect(readUnauthenticated({}, { 'Accept-Language': 'de-AT' })).resolves.toMatchObject({
      body: { privacyPolicy: { language: 'en', source: 'standard' } },
    });

    // With no session, the global auth guard refuses the write before the
    // route's own guard asks for the permission.
    expectErrorEnvelope(await put({}), { status: 401, code: 'UNAUTHORIZED' });
    await put(user.headers).expect(403);
    await put(moderator.headers).expect(403);
    await expect(db.client.privacyPolicy.count()).resolves.toBe(0);

    const replaced = await put(admin.headers).expect(200);

    expect(replaced.body).toEqual({
      privacyPolicy: {
        availableLanguages: ['de', 'en'],
        language: 'de',
        markdown: GERMAN,
        source: 'operator',
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
    });

    // The removal is refused to them too, while there is a text to remove.
    expectErrorEnvelope(await remove({}), { status: 401, code: 'UNAUTHORIZED' });
    await remove(user.headers).expect(403);
    await remove(moderator.headers).expect(403);

    const byName = await readUnauthenticated({ lang: 'de' });

    expect(byName.headers['content-language']).toBe('de');
    expect(byName.body.privacyPolicy).toEqual(replaced.body.privacyPolicy);

    // A regional tag matches its base language.
    const byHeader = await readUnauthenticated({}, { 'Accept-Language': 'de-AT' });

    expect(byHeader.headers['content-language']).toBe('de');
    expect(byHeader.body.privacyPolicy).toEqual(replaced.body.privacyPolicy);
  });

  it('falls back to the file once an Admin removes their text', async () => {
    const admin = await actors.admin();

    await request(baseUrl).put(GERMAN_PATH).set(admin.headers).send({ markdown: GERMAN }).expect(200);
    // The control: the German text is served before the removal, so the
    // English answer after it comes from the removal.
    await expect(readUnauthenticated({ lang: 'de' })).resolves.toMatchObject({
      body: { privacyPolicy: { language: 'de', source: 'operator' } },
    });

    await request(baseUrl).delete(GERMAN_PATH).set(admin.headers).expect(204);

    const after = await readUnauthenticated({ lang: 'de' });

    expect(after.headers['content-language']).toBe('en');
    expect(after.body.privacyPolicy).toMatchObject({ availableLanguages: ['en'], language: 'en', source: 'standard' });

    // Nothing is left to remove.
    expectErrorEnvelope(await request(baseUrl).delete(GERMAN_PATH).set(admin.headers), {
      status: 404,
      code: 'PRIVACY_POLICY_NOT_FOUND',
    });
  });

  // A signed-in reader's stored language is tried before Accept-Language, so a
  // client needn't send it as `lang` (#934). German has no catalog, so this
  // also shows the policy matches the stored tag itself, not the interface
  // language the request resolved to.
  it('serves a signed-in reader the policy in their stored language, with no lang', async () => {
    const admin = await actors.admin();
    await request(baseUrl).put(GERMAN_PATH).set(admin.headers).send({ markdown: GERMAN }).expect(200);

    // A fresh user, whose preference is stored before their first request:
    // the api caches a preference for a minute once it has read it.
    const reader = await actors.user();
    const german = await db.client.languageTag.findUniqueOrThrow({ where: { tag: 'de' }, select: { id: true } });
    await db.client.userPreferences.upsert({
      where: { userId: reader.user.id },
      create: { userId: reader.user.id, languageTagId: german.id },
      update: { languageTagId: german.id },
    });

    const signedIn = await request(baseUrl).get(PATH).set(reader.headers).set('Accept-Language', 'en').expect(200);

    expect(signedIn.headers['content-language']).toBe('de');
    expect(signedIn.body.privacyPolicy).toMatchObject({ language: 'de', markdown: GERMAN, source: 'operator' });

    // The control: the same request without the session is served English.
    await expect(readUnauthenticated({}, { 'Accept-Language': 'en' })).resolves.toMatchObject({
      body: { privacyPolicy: { language: 'en', source: 'standard' } },
    });

    // `lang` still comes first.
    await expect(
      request(baseUrl).get(PATH).query({ lang: 'en' }).set(reader.headers).expect(200),
    ).resolves.toMatchObject({ body: { privacyPolicy: { language: 'en' } } });
  });

  // Each write is audited (#934). The entries are read from the audit log
  // itself, where the unit specs see only the events that feed it.
  it('audits each write as the Admin who made it: the first replace as a create, the removal as a delete', async () => {
    const admin = await actors.admin();

    await request(baseUrl).put(GERMAN_PATH).set(admin.headers).send({ markdown: GERMAN }).expect(200);
    // The answer carries no row id, so the audit entries' subject is read here.
    const { id } = await db.client.privacyPolicy.findFirstOrThrow({
      where: { languageTag: { tag: 'de' } },
      select: { id: true },
    });

    const created = expect.objectContaining({
      action: 'create',
      actorUserId: admin.user.id,
      event: REPLACED,
      payload: { before: null, after: expect.objectContaining({ id, markdown: GERMAN }) },
    });

    await expect(auditEntriesOnceOneIs(id, REPLACED)).resolves.toEqual([created]);

    await request(baseUrl).delete(GERMAN_PATH).set(admin.headers).expect(204);

    await expect(auditEntriesOnceOneIs(id, REMOVED)).resolves.toEqual([
      created,
      expect.objectContaining({
        action: 'delete',
        actorUserId: admin.user.id,
        event: REMOVED,
        payload: { before: expect.objectContaining({ id, markdown: GERMAN }), after: null },
      }),
    ]);
  });
});
