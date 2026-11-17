import type { Actor } from '@bge/actor-context';
import { AuthType, DataGatewayCapability, PluginCategory, PluginScope } from '@bge/database';
import { status } from '@grpc/grpc-js';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { useCoordinator } from '../support/coordinator';
import { FIRST_BUILD } from '../support/fixture-build';
import type { PlacedPlugin, SeededPlugin } from '../support/plugin-on-disk';
import { clearPluginRows, placeFixturePlugin, seedPluginRows, usePluginsRoot } from '../support/plugin-on-disk';
import { readRoutedPlugin, useRelaySource } from '../support/relay-source';
import { useTestDatabase } from '../support/test-db';

const SLUG = 'routing-gateway';

/** A plugin of a category the api loads, with nothing on disk: loading it would quarantine it. */
const OTHER_CATEGORY_SLUG = 'routing-event-hook';

/** The fixture's one game, as a search's frames carry it: a result, then the end of the DataGateway's results. */
const THE_GAME_THEN_DONE = [
  expect.objectContaining({ status: 'RESULT_STATUS_RESULT', game: expect.objectContaining(FIRST_BUILD.game) }),
  expect.objectContaining({ status: 'RESULT_STATUS_SOURCE_DONE' }),
];

/**
 * A plugin DataGateway as the rest of the server meets it (#1083): the built
 * coordinator, running as its own process over a real Postgres and Redis,
 * loads a data-gateway plugin from a plugins root and answers for it over
 * both protocols it serves. Nothing here reaches into the coordinator: the
 * specs call it over gRPC, write the rows an admin's actions would write, and
 * read the rows it wrote.
 */
describe('a plugin DataGateway the coordinator runs', () => {
  const db = useTestDatabase();
  const pluginsRoot = usePluginsRoot();

  let placed: PlacedPlugin;
  let plugin: SeededPlugin;

  // Before the coordinator launches: what it loads is decided when it boots.
  beforeAll(async () => {
    await clearPluginRows(db());
    placed = await placeFixturePlugin(pluginsRoot(), { entry: 'index', slug: SLUG });
    plugin = await seedPluginRows(db(), placed);

    await db().plugin.create({
      data: {
        slug: OTHER_CATEGORY_SLUG,
        version: '1.0.0',
        category: PluginCategory.EventHook,
        scope: PluginScope.Server,
        manifestJson: { slug: OTHER_CATEGORY_SLUG, version: '1.0.0' },
        installedSha256: 'e'.repeat(64),
        enabled: true,
      },
    });
  });

  const coordinator = useCoordinator({ pluginsRoot });
  const relay = useRelaySource(coordinator);

  /**
   * A search the coordinator has not answered before. It caches a
   * DataGateway's results by query, and an answer replayed from the cache
   * would say nothing about whether the plugin's driver was reached.
   */
  let searches = 0;
  const freshQuery = (): string => `search ${++searches}`;

  /** Both protocols' answers to a search of the plugin DataGateway, each asked afresh. */
  const searchBothWays = async () => ({
    coordinator: await coordinator().service.searchGames(plugin.gatewayId, freshQuery()),
    gateway: await coordinator()
      .gateway({ gatewayId: plugin.gatewayId })
      .searchGames(freshQuery())
      .catch((error: unknown) => error),
  });

  it('loads the plugin, interviews it and routes search and fetch through CoordinatorService (#1083)', async () => {
    const loads = await db().pluginProcessLoad.findMany({ where: { slug: SLUG } });
    expect(loads).toEqual([expect.objectContaining({ processRole: 'coordinator', sha256: placed.sha256 })]);

    const frames = await coordinator().service.searchGames(plugin.gatewayId, freshQuery());
    expect(frames).toEqual(THE_GAME_THEN_DONE);
    expect(frames.map((frame) => frame.gatewayId)).toEqual([plugin.gatewayId, plugin.gatewayId]);

    const fetched = await coordinator().service.fetchGame(plugin.gatewayId, FIRST_BUILD.game.externalId);
    expect(fetched).toMatchObject({
      gatewayId: plugin.gatewayId,
      status: 'RESULT_STATUS_RESULT',
      game: FIRST_BUILD.game,
    });

    // Its first use interviewed it: no interview runs at boot for a plugin DataGateway.
    const row = await db().dataGateway.findUniqueOrThrow({ where: { id: plugin.gatewayId } });
    expect(row.firstInterviewedAt).toEqual(expect.any(Date));
    expect(row.capabilities).toEqual([
      DataGatewayCapability.Search,
      DataGatewayCapability.Fetch,
      DataGatewayCapability.FetchGames,
    ]);
  });

  // The gateway worker asks the coordinator's plugin load records whether a
  // plugin is loaded, so the record must say so, and for which install. The
  // switch-on that found nothing loaded marked the plugin restart required,
  // and the boot that loaded it clears that.
  it('records its load as ready, for the install the plugin row names (#1083)', async () => {
    const loads = await db().pluginProcessLoad.findMany({ where: { slug: SLUG } });
    expect(loads).toEqual([
      expect.objectContaining({
        processRole: 'coordinator',
        sha256: placed.sha256,
        installedAt: plugin.installedAt,
        ready: true,
      }),
    ]);

    const row = await db().plugin.findUniqueOrThrow({ where: { id: plugin.pluginId } });
    expect(row).toMatchObject({ enabled: true, loadFailed: false, restartRequired: false });
  });

  it('does not load a plugin of another category (#1083)', async () => {
    const row = await db().plugin.findUniqueOrThrow({ where: { slug: OTHER_CATEGORY_SLUG } });
    expect(row).toMatchObject({ enabled: true, loadFailed: false, loadError: null });

    await expect(db().pluginProcessLoad.findMany({ where: { slug: OTHER_CATEGORY_SLUG } })).resolves.toEqual([]);
  });

  it('serves the same DataGateway over the gateway protocol, keyed by its id (#1083)', async () => {
    const named = coordinator().gateway({ gatewayId: plugin.gatewayId });
    await expect(named.searchGames(freshQuery())).resolves.toEqual(THE_GAME_THEN_DONE);
    await expect(named.fetchGame(FIRST_BUILD.game.externalId)).resolves.toMatchObject({
      status: 'RESULT_STATUS_RESULT',
      game: FIRST_BUILD.game,
    });

    // Ping names no capability, and is the plugin's own to answer: its
    // version is what brings an interview forward.
    const pingedAt = Date.now();
    const pong = await named.ping();
    expect(pong).toMatchObject({ gatewayName: SLUG, gatewayVersion: FIRST_BUILD.version });
    expect(Number(pong.timestampMs)).toBeGreaterThanOrEqual(pingedAt);
    expect(Number(pong.timestampMs)).toBeLessThanOrEqual(Date.now());

    await expect(coordinator().gateway().searchGames(freshQuery())).rejects.toMatchObject({
      code: status.INVALID_ARGUMENT,
    });
    await expect(
      coordinator().gateway({ gatewayId: 'no-such-data-gateway' }).searchGames(freshQuery()),
    ).rejects.toMatchObject({ code: status.NOT_FOUND });

    // Made once the coordinator is up, so its boot never dials this address.
    const remote = await db().dataGateway.create({
      data: {
        name: 'A remote DataGateway',
        connectionUrl: '127.0.0.1',
        connectionPort: 9,
        authType: AuthType.None,
        enabled: true,
      },
      select: { id: true },
    });

    try {
      await expect(coordinator().gateway({ gatewayId: remote.id }).searchGames(freshQuery())).rejects.toMatchObject({
        code: status.NOT_FOUND,
      });
    } finally {
      await db().dataGateway.delete({ where: { id: remote.id } });
    }
  });

  // A plugin's work always has a trigger to be attributed to, so the
  // coordinator answers no gateway protocol call that carries no actor, as it
  // answers none of its own. The probe would answer with the actor the
  // plugin ran as, had the call reached the plugin.
  //
  // The refusal is the coordinator's own, not any failure such as a deadline
  // passing. Its actor interceptor throws an HTTP exception, which Nest's RPC
  // layer doesn't map to a gRPC status, so the call ends UNKNOWN today; it
  // should end UNAUTHENTICATED, and this must still hold once it does.
  it('answers no gateway protocol call that carries no actor (#1083)', async () => {
    const anonymous = coordinator().gateway({ gatewayId: plugin.gatewayId, actor: null });
    const refusedForNoActor = [status.UNKNOWN, status.UNAUTHENTICATED];
    const codeOf = (call: Promise<unknown>): Promise<unknown> =>
      call.then(
        () => 'answered',
        (error: { readonly code?: unknown }) => error.code,
      );

    expect(refusedForNoActor).toContain(await codeOf(anonymous.fetchGame(FIRST_BUILD.actorProbeExternalId)));
    expect(refusedForNoActor).toContain(await codeOf(anonymous.searchGames(freshQuery())));
    expect(refusedForNoActor).toContain(await codeOf(anonymous.ping()));
  });

  it("the gateway worker's source reaches it (#1083)", async () => {
    await expect(relay().isLoaded(await readRoutedPlugin(db(), plugin.pluginId))).resolves.toBe(true);

    const driver = await relay().build(plugin.gatewayId);

    const frames = await lastValueFrom(
      driver.searchGames({ correlationId: 'relay-search', query: freshQuery() }).pipe(toArray()),
    );
    expect(frames).toEqual(THE_GAME_THEN_DONE);

    const fetched = await firstValueFrom(
      driver.fetchGame({ correlationId: 'relay-fetch', externalId: FIRST_BUILD.game.externalId }),
    );
    expect(fetched).toMatchObject({ status: 'RESULT_STATUS_RESULT', game: FIRST_BUILD.game });
  });

  // A plugin acts with the authority consented to it, and whoever set it
  // running is only its trigger. The fixture's driver answers the probe with
  // the actor its code ran as, so this reads that actor across both wires:
  // the coordinator's actor interceptor must put the actor a call carries in
  // scope before the handler runs, and the gateway worker's source must send
  // the actor of the job that called it.
  it("runs the plugin's driver as the plugin actor, for the whole server, with the actor the call carried as its trigger (#1083)", async () => {
    const asThePlugin = (trigger: Actor) => ({
      kind: 'plugin',
      pluginId: plugin.pluginId,
      unit: { scopeType: 'Server' },
      trigger,
    });
    const actorSeenIn = (answer: { readonly message?: string }): unknown => JSON.parse(answer.message ?? 'null');

    const aUser: Actor = { kind: 'user', userId: 'a-user-waiting-on-screen' };
    const throughTheCoordinator = await coordinator().service.fetchGame(
      plugin.gatewayId,
      FIRST_BUILD.actorProbeExternalId,
      aUser,
    );
    expect(actorSeenIn(throughTheCoordinator)).toEqual(asThePlugin(aUser));

    const driver = await relay().build(plugin.gatewayId);
    const probe = { correlationId: 'relay-probe', externalId: FIRST_BUILD.actorProbeExternalId };

    const forAJob = await relay().asJob('an-import-job', () => firstValueFrom(driver.fetchGame(probe)));
    expect(actorSeenIn(forAJob)).toEqual(asThePlugin({ kind: 'system', reason: 'an-import-job' }));

    // Called by nobody's work, as the interview's hourly backstop calls it:
    // the source sends the system actor, naming itself.
    const forNobody = await firstValueFrom(driver.fetchGame(probe));
    expect(actorSeenIn(forNobody)).toEqual(asThePlugin({ kind: 'system', reason: 'plugin-gateway-relay' }));
  });

  it('stops routing when the plugin is disabled in the database, with no restart (#1083)', async () => {
    await db().plugin.update({ where: { id: plugin.pluginId }, data: { enabled: false } });

    try {
      const refused = await searchBothWays();
      expect(refused.coordinator).toEqual([
        expect.objectContaining({
          status: 'RESULT_STATUS_UNAVAILABLE',
          message: expect.stringContaining('plugin is disabled'),
        }),
      ]);
      expect(refused.gateway).toMatchObject({ code: status.FAILED_PRECONDITION });
    } finally {
      await db().plugin.update({ where: { id: plugin.pluginId }, data: { enabled: true } });
    }

    const answered = await searchBothWays();
    expect(answered.coordinator).toEqual(THE_GAME_THEN_DONE);
    expect(answered.gateway).toEqual(THE_GAME_THEN_DONE);
  });

  // An admin who asks for an interview is told which fix applies: here,
  // switching the plugin on.
  it('answers ReinterviewGateway with why, while the plugin is switched off (#1083)', async () => {
    await db().plugin.update({ where: { id: plugin.pluginId }, data: { enabled: false } });

    try {
      await expect(coordinator().service.reinterviewGateway(plugin.gatewayId)).resolves.toMatchObject({
        success: false,
        refusalReason: 'plugin_not_served',
      });
    } finally {
      await db().plugin.update({ where: { id: plugin.pluginId }, data: { enabled: true } });
    }

    await expect(coordinator().service.reinterviewGateway(plugin.gatewayId)).resolves.toMatchObject({ success: true });
  });

  it('stops routing when the row is disabled (#1083)', async () => {
    await db().dataGateway.update({ where: { id: plugin.gatewayId }, data: { enabled: false } });

    try {
      const refused = await searchBothWays();
      expect(refused.coordinator).toEqual([
        expect.objectContaining({
          status: 'RESULT_STATUS_UNAVAILABLE',
          message: `DataGateway ${plugin.gatewayId} is disabled`,
        }),
      ]);
      expect(refused.gateway).toMatchObject({ code: status.FAILED_PRECONDITION });
    } finally {
      await db().dataGateway.update({ where: { id: plugin.gatewayId }, data: { enabled: true } });
    }

    const answered = await searchBothWays();
    expect(answered.coordinator).toEqual(THE_GAME_THEN_DONE);
    expect(answered.gateway).toEqual(THE_GAME_THEN_DONE);
  });

  // ConnectGateway dials a remote DataGateway at the address it is given. A
  // plugin DataGateway has none, and to whoever asks to dial it, no remote
  // DataGateway by that id is there.
  it("refuses ConnectGateway for the plugin's row, and leaves the row as it was (#1083)", async () => {
    const before = await db().dataGateway.findUniqueOrThrow({ where: { id: plugin.gatewayId } });

    const reply = await coordinator().service.connectGateway({
      gatewayId: plugin.gatewayId,
      connectionUrl: '127.0.0.1',
      connectionPort: 9,
      authType: AuthType.None,
    });
    expect(reply).toMatchObject({ success: false, refusalReason: 'unknown' });

    await expect(db().dataGateway.findUniqueOrThrow({ where: { id: plugin.gatewayId } })).resolves.toEqual(before);

    // The plugin's driver was not replaced by a dialled one.
    const answered = await searchBothWays();
    expect(answered.coordinator).toEqual(THE_GAME_THEN_DONE);
    expect(answered.gateway).toEqual(THE_GAME_THEN_DONE);
  });
});
