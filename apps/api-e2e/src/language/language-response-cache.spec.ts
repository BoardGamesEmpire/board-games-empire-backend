import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { apiCacheHas, responseCacheKey } from '../support/api-cache';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const LANGUAGES_PATH = '/api/languages';
const ME_PATH = '/api/users/me';

/**
 * The response cache is opt-in (#530), and the language reads are its first
 * routes.
 *
 * A cached route reports its lookup in `X-Cache`, a `MISS` and then a `HIT`,
 * and a route that isn't cached sends no `X-Cache` at all. The api reads a
 * HIT on the cache connection it queued the MISS's write on, so the HIT can't
 * race that write. `apiCacheHas` then pins whose entry it was.
 *
 * Each test uses a fresh user, whose namespace no earlier request could have
 * written.
 */
describe('language response cache', () => {
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

  const cacheStatus = async (path: string, headers: Record<string, string>) =>
    (await request(baseUrl).get(path).set(headers).expect(200)).headers['x-cache'];

  it('caches both language reads, per caller', async () => {
    const actor = await actors.user();
    const { id } = await db.client.language.findFirstOrThrow({ select: { id: true } });

    for (const path of [LANGUAGES_PATH, `${LANGUAGES_PATH}/${id}`]) {
      await expect(cacheStatus(path, actor.headers)).resolves.toBe('MISS');
      await expect(cacheStatus(path, actor.headers)).resolves.toBe('HIT');
      await expect(apiCacheHas(responseCacheKey(`user:${actor.user.id}`, path))).resolves.toBe(true);
    }
  });

  it('does not cache a route that has not opted in', async () => {
    const actor = await actors.user();

    await expect(cacheStatus(ME_PATH, actor.headers)).resolves.toBeUndefined();
    await expect(cacheStatus(ME_PATH, actor.headers)).resolves.toBeUndefined();
    // The same caller's cached read does carry the header, so its absence
    // above is the route skipping the cache.
    await expect(cacheStatus(LANGUAGES_PATH, actor.headers)).resolves.toBe('MISS');

    await expect(apiCacheHas(responseCacheKey(`user:${actor.user.id}`, ME_PATH))).resolves.toBe(false);
  });
});
