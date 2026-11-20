import type { Plugin } from '@bge/database';
import { PluginScope } from '@bge/database';
import type { Actors } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangeInventoryPlugin } from '../plugin/inventory-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

/**
 * Signed-in server discovery on the wire (#78): who may read it, its shape,
 * which plugins it lists and in which language, that it is never served from
 * a cache, and that the bge-identity document points at it.
 *
 * Plugin rows are arranged directly, as the other plugin suites do. The read
 * lists every running server-scope plugin, so each test asserts on its own
 * slug, never on the whole list.
 */
describe('signed-in server discovery (#78)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PATH = '/api/discovery/server';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const arrangeRunning = (row: Record<string, unknown> = {}): Promise<Plugin> =>
    arrangeInventoryPlugin(db.client, { row: { scope: PluginScope.Server, enabled: true, ...row } });

  const readAs = async (headers: Record<string, string>) => request(baseUrl).get(PATH).set(headers).expect(200);

  type Listed = { category: string; displayName: string; slug: string };

  const entryFor = (body: { serverPlugins: Listed[] }, slug: string) =>
    body.serverPlugins.find((entry) => entry.slug === slug);

  it('refuses an unauthenticated request', async () => {
    await request(baseUrl).get(PATH).expect(401);
  });

  it('answers a registered user with the documented shape', async () => {
    const user = await actors.user();

    const { body } = await readAs(user.headers);

    expect(Object.keys(body).sort()).toEqual(['coreAreas', 'discoverySchemaVersion', 'serverPlugins']);
    expect(body.discoverySchemaVersion).toBe(1);
    expect(body.coreAreas).toEqual({ households: true, events: true, friendships: true });
    expect(Array.isArray(body.serverPlugins)).toBe(true);
  });

  it('answers an anonymous user the same way, plugins included', async () => {
    const anonymousUser = await actors.anonymous();
    // An anonymous user holds no plugin read, so this fails if the read is
    // ever composed under the actor's ceiling.
    const plugin = await arrangeRunning();

    const { body } = await readAs(anonymousUser.headers);

    expect(body.coreAreas).toEqual({ households: true, events: true, friendships: true });
    expect(entryFor(body, plugin.slug)).toEqual({
      slug: plugin.slug,
      category: 'FeedbackSink',
      displayName: 'Inventory Fixture',
    });
  });

  it('lists a running server-scope plugin by slug, plugin category and display name, and nothing more', async () => {
    const user = await actors.user();
    const plugin = await arrangeRunning();

    const { body } = await readAs(user.headers);

    expect(entryFor(body, plugin.slug)).toEqual({
      slug: plugin.slug,
      category: 'FeedbackSink',
      displayName: 'Inventory Fixture',
    });
  });

  // Only `en` is a supported locale (#135), so the api never hands this read a
  // `de` locale, although the fixture plugin manifest carries a German name.
  // That the request locale reaches the plugin manifest is proven in the unit
  // specs, where the locale is supplied directly. What e2e can pin is that a language the server
  // does not ship degrades to the default display name rather than erroring or emptying it.
  it('gives the display name in the default language for a language the server does not ship', async () => {
    const user = await actors.user();
    const plugin = await arrangeRunning();

    const { body } = await readAs({ ...user.headers, 'Accept-Language': 'de' });

    expect(entryFor(body, plugin.slug)?.displayName).toBe('Inventory Fixture');
  });

  it('drops a plugin on the next read once it is switched off', async () => {
    const user = await actors.user();
    const plugin = await arrangeRunning();

    expect(entryFor((await readAs(user.headers)).body, plugin.slug)).toBeDefined();

    await db.client.plugin.update({ where: { id: plugin.id }, data: { enabled: false } });

    expect(entryFor((await readAs(user.headers)).body, plugin.slug)).toBeUndefined();
  });

  it('leaves out uninstalled, household-scope and failed-to-load plugins', async () => {
    const user = await actors.user();
    // The running one is the control: the read lists it, so the absences
    // below come from the filter, not from an empty or failing read.
    const running = await arrangeRunning();
    const uninstalled = await arrangeRunning({ uninstalledAt: new Date() });
    const householdScope = await arrangeRunning({ scope: PluginScope.Household });
    // Switched back on after the loader quarantined it: the failure stays
    // marked until a restart loads it, so it is not running.
    const failedToLoad = await arrangeRunning({ loadFailed: true, loadError: 'entrypoint missing' });

    const { body } = await readAs(user.headers);

    expect(entryFor(body, running.slug)).toBeDefined();
    expect(entryFor(body, uninstalled.slug)).toBeUndefined();
    expect(entryFor(body, householdScope.slug)).toBeUndefined();
    expect(entryFor(body, failedToLoad.slug)).toBeUndefined();
  });

  it('is private, never cached by the api, and revalidates to 304', async () => {
    const user = await actors.user();

    const first = await readAs(user.headers);

    expect(first.headers['cache-control']).toBe('private, no-cache');
    // A route the api caches reports its lookup in X-Cache; this one sends none.
    expect(first.headers['x-cache']).toBeUndefined();
    expect(first.headers['etag']).toEqual(expect.any(String));

    await request(baseUrl)
      .get(PATH)
      .set({ ...user.headers, 'If-None-Match': first.headers['etag'] })
      .expect(304);
  });

  it('is where the bge-identity document points', async () => {
    const user = await actors.user();

    const identity = await request(baseUrl).get('/.well-known/bge-identity').expect(200);
    const pointer = identity.body.bge_server_discovery_endpoint;

    expect(pointer).toBe(PATH);
    await request(baseUrl).get(pointer).set(user.headers).expect(200);
  });
});
