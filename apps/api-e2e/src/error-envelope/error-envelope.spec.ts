import { createActors, type Actors } from '@bge/testing-e2e';
import { request as httpRequest } from 'node:http';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * One error envelope from every producer (#1260): the global filter's markers,
 * validation, coded throws, a pipe, the Host check that answers before Nest
 * sees the request, and `/api/auth`'s own answers. Each case is a producer, so
 * a new one that skips the envelope shows up here as one failing case.
 */
describe('every HTTP error leaves in one envelope (#1260)', () => {
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

  it('a 404 rendered from a catalog key, which names no code', async () => {
    const user = await actors.user();

    const response = await request(baseUrl).get('/api/languages/clmissinglanguage0000000000').set(user.headers);

    expectErrorEnvelope(response, { status: 404, code: null });
  });

  it("a validation 400, whose message lists each field's problem", async () => {
    const response = await request(baseUrl).get('/api/languages').query({ limit: 'abc' });

    expectErrorEnvelope(response, { status: 400, code: null });
    expect(Array.isArray(response.body.message)).toBe(true);
  });

  it('a coded 401 from the guard, for a request with no credential', async () => {
    const response = await request(baseUrl).get('/api/game-collections');

    expectErrorEnvelope(response, { status: 401, code: 'UNAUTHORIZED' });
  });

  it('a coded 404 from a pipe, before any handler runs', async () => {
    const owner = await actors.owner();

    const response = await request(baseUrl)
      .patch('/api/permission-catalog/permissions/read:game%00')
      .set(owner.headers)
      .send({ reason: 'A reason the edit never reaches' });

    expectErrorEnvelope(response, { status: 404, code: 'CATALOG_ENTRY_NOT_FOUND' });
  });

  it('the Host check, which answers before Nest sees the request', async () => {
    const response = await request(baseUrl).get('/api/games').set('Host', 'evil.example');

    expectErrorEnvelope(response, { status: 421, code: 'HOST_NOT_ALLOWED' });
  });

  it("an answer of /api/auth's own, which better-auth never sees", async () => {
    const { hostname, port } = new URL(baseUrl);

    // A body declaring more than the 64 KiB limit is refused before it is
    // read, so only the headers are sent.
    const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const sent = httpRequest({
        hostname,
        port,
        path: '/api/auth/sign-in/email',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 64 * 1024 + 1 },
      });
      sent.on('error', () => undefined);
      sent.on('response', (answer) => {
        let text = '';
        answer.setEncoding('utf8');
        answer.on('data', (chunk: string) => (text += chunk));
        answer.on('end', () => {
          resolve({ status: answer.statusCode ?? 0, body: JSON.parse(text) });
          sent.destroy();
        });
        answer.on('error', reject);
      });
      sent.flushHeaders();
    });

    expectErrorEnvelope(response, { status: 413, code: 'REQUEST_TOO_LARGE' });
  });
});
