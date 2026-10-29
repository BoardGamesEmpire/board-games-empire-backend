import { PluginGrantStatus, ResourceType, type Plugin } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeInventoryPlugin } from './inventory-fixtures';

/**
 * The server plugin writes gate on a type-level `can(manage, Plugin)`, which a
 * key's `manage:plugin` passes whatever plugin its scope names, and the service
 * seam checks only that the acting user is a server admin: it never sees the
 * key. So an Admin's key pinned to plugin A could uninstall plugin B (#978).
 *
 * Each write now resolves its slug under the actor's `manage` ceiling first,
 * as the reads do under `read` (#789), and answers a plugin outside the key's
 * scope exactly as it answers a slug never installed. The check runs before
 * the service, so nothing is written and no other state shows through.
 *
 * Every request carries a body its DTO accepts, since validation runs before
 * the handler and a 400 would hide the answer under test.
 */
describe('server plugin writes through a key scoped to one plugin (#978)', () => {
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

  const WRITES = {
    'POST /plugins/:slug/grants': (actor, slug) =>
      request(baseUrl)
        .post(`/api/plugins/${slug}/grants`)
        .set(actor.headers)
        .send({ permissionSlug: `plugin|${slug}|manage:digest`, status: PluginGrantStatus.Granted }),
    'POST /plugins/:slug/enable': (actor, slug) =>
      request(baseUrl).post(`/api/plugins/${slug}/enable`).set(actor.headers).send({}),
    'POST /plugins/:slug/disable': (actor, slug) =>
      request(baseUrl).post(`/api/plugins/${slug}/disable`).set(actor.headers).send({}),
    'PATCH /plugins/:slug/config': (actor, slug) =>
      request(baseUrl).patch(`/api/plugins/${slug}/config`).set(actor.headers).send({ config: {} }),
    'POST /plugins/:slug/uninstall': (actor, slug) =>
      request(baseUrl).post(`/api/plugins/${slug}/uninstall`).set(actor.headers).send({}),
    'POST /plugins/:slug/update/approve': (actor, slug) =>
      request(baseUrl).post(`/api/plugins/${slug}/update/approve`).set(actor.headers).send({}),
    'POST /plugins/:slug/update/reject': (actor, slug) =>
      request(baseUrl).post(`/api/plugins/${slug}/update/reject`).set(actor.headers).send({}),
  } as const satisfies Record<string, (actor: Caller, slug: string) => request.Test>;

  type Write = keyof typeof WRITES;

  const answers = async (actor: Caller, slug: string): Promise<Record<string, [number, unknown]>> => {
    const answered: Record<string, [number, unknown]> = {};

    for (const [name, send] of Object.entries(WRITES)) {
      const response = await send(actor, slug);
      answered[name] = [response.status, response.body.code];
    }

    return answered;
  };

  /** Sends each write in order, to its own slug, and records each status. */
  const statusesOf = async (actor: Caller, sends: readonly (readonly [Write, string])[]) => {
    const statuses: [Write, number][] = [];

    for (const [name, slug] of sends) {
      statuses.push([name, (await WRITES[name](actor, slug)).status]);
    }

    return statuses;
  };

  /** `manage:plugin`, pinned to `scoped` when it is given. */
  const manageKey = (owner: SessionActor, scoped?: Plugin) =>
    mintApiKey(baseUrl, db.client, owner, {
      slugs: ['manage:plugin'],
      resourceType: ResourceType.Plugin,
      resourceId: scoped?.id,
    });

  /** What a write could change: the plugin's row and its grants. */
  const stateOf = async (plugin: Plugin) => ({
    row: await db.client.plugin.findUniqueOrThrow({ where: { id: plugin.id } }),
    grants: await db.client.pluginGrant.count({ where: { pluginId: plugin.id } }),
  });

  it('answers 404 on all seven for any other plugin, whatever its state, and leaves it unchanged', async () => {
    const admin = await actors.admin();
    const [scoped, live, gone, staged] = await Promise.all([
      arrangeInventoryPlugin(db.client),
      arrangeInventoryPlugin(db.client),
      arrangeInventoryPlugin(db.client, { row: { uninstalledAt: new Date() } }),
      arrangeInventoryPlugin(db.client, { stagedVersion: '9.9.9' }),
    ]);
    const key = await manageKey(admin, scoped);
    const missing = `missing-${randomUUID()}`;
    const statesOfOthers = async () => ({
      live: await stateOf(live),
      gone: await stateOf(gone),
      staged: await stateOf(staged),
    });
    const before = await statesOfOthers();

    // What each route answers a slug never installed: its own code, the one
    // its service draws for an unknown slug.
    const unknown = await answers(admin, missing);
    expect(unknown).toEqual({
      'POST /plugins/:slug/grants': [404, 'PluginGrantPluginNotFoundError'],
      'POST /plugins/:slug/enable': [404, 'PluginLifecycleNotFoundError'],
      'POST /plugins/:slug/disable': [404, 'PluginLifecycleNotFoundError'],
      'PATCH /plugins/:slug/config': [404, 'PluginLifecycleNotFoundError'],
      'POST /plugins/:slug/uninstall': [404, 'PluginLifecycleNotFoundError'],
      'POST /plugins/:slug/update/approve': [404, 'PluginUpdatePluginNotFoundError'],
      'POST /plugins/:slug/update/reject': [404, 'PluginUpdatePluginNotFoundError'],
    });

    const others = { missing, live: live.slug, gone: gone.slug, staged: staged.slug };
    const answered: Record<string, unknown> = {};
    for (const [state, slug] of Object.entries(others)) {
      answered[state] = await answers(key, slug);
    }

    expect(answered).toEqual(Object.fromEntries(Object.keys(others).map((state) => [state, unknown])));
    await expect(statesOfOthers()).resolves.toEqual(before);

    // The controls, once nothing else needs the plugins as they were: the key
    // writes its own plugin, and an unpinned key from the same owner reaches
    // the others on all seven writes, so the 404s above are the pin's.
    expect(
      await statusesOf(key, [
        ['POST /plugins/:slug/enable', scoped.slug],
        ['POST /plugins/:slug/disable', scoped.slug],
        ['PATCH /plugins/:slug/config', scoped.slug],
      ]),
    ).toEqual([
      ['POST /plugins/:slug/enable', 200],
      ['POST /plugins/:slug/disable', 200],
      ['PATCH /plugins/:slug/config', 200],
    ]);

    // An approval consumes its staged update, so the approval gets a plugin
    // of its own and the rejection keeps `staged`. Uninstalling comes last.
    const approvable = await arrangeInventoryPlugin(db.client, { stagedVersion: '9.9.9' });
    const unpinned = await manageKey(admin);
    expect(
      await statusesOf(unpinned, [
        ['POST /plugins/:slug/grants', live.slug],
        ['POST /plugins/:slug/disable', live.slug],
        ['POST /plugins/:slug/enable', live.slug],
        ['PATCH /plugins/:slug/config', live.slug],
        ['POST /plugins/:slug/update/approve', approvable.slug],
        ['POST /plugins/:slug/update/reject', staged.slug],
        ['POST /plugins/:slug/enable', gone.slug],
        ['POST /plugins/:slug/uninstall', live.slug],
      ]),
    ).toEqual([
      ['POST /plugins/:slug/grants', 200],
      ['POST /plugins/:slug/disable', 200],
      ['POST /plugins/:slug/enable', 200],
      ['PATCH /plugins/:slug/config', 200],
      ['POST /plugins/:slug/update/approve', 200],
      ['POST /plugins/:slug/update/reject', 200],
      ['POST /plugins/:slug/enable', 410],
      ['POST /plugins/:slug/uninstall', 200],
    ]);
  });
});
