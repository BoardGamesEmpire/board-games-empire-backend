import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { cacheIndexSizes } from '../support/api-cache';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const LANGUAGES_PATH = '/api/languages';

/**
 * What the api's cache store leaves in Redis besides its entries: nothing
 * (#449). With its index on, the Valkey adapter keeps a set naming every key
 * the store wrote and drops a name only when the store deletes the key, never
 * when the key expires, so the set grew for as long as Redis kept it.
 *
 * Signing up writes a session to the store, and a language read writes a
 * cached response; the read's MISS and then HIT show that entry landed, so
 * the check isn't passing over a store that wrote nothing. The sets are
 * compared before and after rather than required absent, so one an older
 * build left on a reused Redis doesn't fail the run.
 */
describe("the api's cache store (#449)", () => {
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

  const cacheStatus = async (headers: Record<string, string>) =>
    (await request(baseUrl).get(LANGUAGES_PATH).set(headers).expect(200)).headers['x-cache'];

  it('indexes none of the keys it writes', async () => {
    const before = await cacheIndexSizes();

    const actor = await actors.user();
    await expect(cacheStatus(actor.headers)).resolves.toBe('MISS');
    await expect(cacheStatus(actor.headers)).resolves.toBe('HIT');

    await expect(cacheIndexSizes()).resolves.toEqual(before);
  });
});
