import { pollUntil } from '@bge/testing-e2e/poll';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { status } from '@grpc/grpc-js';
import { lastValueFrom, toArray } from 'rxjs';
import { useCoordinator } from '../support/coordinator';
import type { FixtureBuild } from '../support/fixture-build';
import { FIRST_BUILD } from '../support/fixture-build';
import type { PlacedPlugin, SeededPlugin } from '../support/plugin-on-disk';
import {
  clearPluginRows,
  placeFixturePlugin,
  seedPluginRows,
  storedManifest,
  usePluginsRoot,
} from '../support/plugin-on-disk';
import { readRoutedPlugin, useRelaySource } from '../support/relay-source';
import { useTestDatabase } from '../support/test-db';

const SLUG = 'lifecycle-gateway';

/** The plugin's next version: another game title, and another answer to the interview. */
const SECOND_BUILD: FixtureBuild = {
  ...FIRST_BUILD,
  version: '2.0.0',
  game: { ...FIRST_BUILD.game, title: 'Fixture Game, second build' },
  fetchGamesMaxIds: 25,
};

/** A build's one game, as a search's frames carry it: a result, then the end of the DataGateway's results. */
const theGameThenDone = (build: FixtureBuild) => [
  expect.objectContaining({ status: 'RESULT_STATUS_RESULT', game: expect.objectContaining(build.game) }),
  expect.objectContaining({ status: 'RESULT_STATUS_SOURCE_DONE' }),
];

/**
 * A plugin runs as one copy, in the coordinator, and nothing swaps that copy
 * while the coordinator runs (#1083). So what the plugin's row says and what
 * the coordinator holds can part: a reinstall makes the copy in memory
 * another install's, which must never be routed, and an update leaves the
 * copy in memory serving until the coordinator restarts. These specs write
 * the row as each of those leaves it, and restart the coordinator.
 */
describe("a plugin DataGateway across its plugin's reinstall and update", () => {
  const db = useTestDatabase();
  const pluginsRoot = usePluginsRoot();

  let first: PlacedPlugin;
  let plugin: SeededPlugin;

  // Before the coordinator launches: what it loads is decided when it boots.
  beforeAll(async () => {
    await clearPluginRows(db());
    first = await placeFixturePlugin(pluginsRoot(), { entry: 'index', slug: SLUG });
    plugin = await seedPluginRows(db(), first);
  });

  const coordinator = useCoordinator({ pluginsRoot });
  const relay = useRelaySource(coordinator);

  /** A search the coordinator has not answered before, so none is replayed from its search cache. */
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

  const isLoadedForTheGatewayWorker = async (): Promise<boolean> =>
    relay().isLoaded(await readRoutedPlugin(db(), plugin.pluginId));

  /**
   * What uninstalling the plugin and installing the same plugin artifact
   * again leave on its row, once a server admin has switched it on again: a
   * new install, marked restart required. The uninstall and the reinstall
   * each touch more on the way, the DataGateway row's `enabled` among it,
   * and leave it as it was.
   */
  const reinstall = (): Promise<unknown> =>
    db().plugin.update({
      where: { id: plugin.pluginId },
      data: { installedAt: new Date(), restartRequired: true },
    });

  describe('once the plugin is reinstalled', () => {
    it('never routes the copy it loaded before a reinstall (#1083)', async () => {
      const served = await searchBothWays();
      expect(served.coordinator).toEqual(theGameThenDone(FIRST_BUILD));
      expect(served.gateway).toEqual(theGameThenDone(FIRST_BUILD));

      await reinstall();

      const refused = await searchBothWays();
      expect(refused.coordinator).toEqual([
        expect.objectContaining({
          status: 'RESULT_STATUS_UNAVAILABLE',
          message: `DataGateway ${plugin.gatewayId}'s plugin isn't loaded: restart the coordinator`,
        }),
      ]);
      expect(refused.gateway).toMatchObject({ code: status.FAILED_PRECONDITION });
      await expect(isLoadedForTheGatewayWorker()).resolves.toBe(false);

      await coordinator().restart();

      const answered = await searchBothWays();
      expect(answered.coordinator).toEqual(theGameThenDone(FIRST_BUILD));
      expect(answered.gateway).toEqual(theGameThenDone(FIRST_BUILD));
      await expect(isLoadedForTheGatewayWorker()).resolves.toBe(true);
    });

    // An admin who asks for an interview is told which fix applies: here,
    // restarting the coordinator.
    it('answers ReinterviewGateway with why, for the copy loaded before a reinstall (#1083)', async () => {
      await reinstall();

      await expect(coordinator().service.reinterviewGateway(plugin.gatewayId)).resolves.toMatchObject({
        success: false,
        refusalReason: 'plugin_not_loaded',
      });

      await coordinator().restart();

      await expect(coordinator().service.reinterviewGateway(plugin.gatewayId)).resolves.toMatchObject({
        success: true,
      });
    });
  });

  describe('once an update is activated', () => {
    let second: PlacedPlugin;

    /** The install the row named before the update, which the update must leave. */
    let installedAt: Date;

    /** The gateway worker's driver, built before the update: its gateway registry keeps the driver across one. */
    let held: DataGatewayDriver;

    const searchThroughTheHeldDriver = () =>
      lastValueFrom(held.searchGames({ correlationId: 'held-driver', query: freshQuery() }).pipe(toArray()));

    beforeAll(async () => {
      held = await relay().build(plugin.gatewayId);
      // Interviewed as the first build before the update, whichever specs ran before this.
      await searchThroughTheHeldDriver();

      ({ installedAt } = await readRoutedPlugin(db(), plugin.pluginId));

      // What activating a staged update writes on the plugin's row: the new
      // version, its plugin manifest and its plugin artifact's checksum,
      // marked restart required. It leaves `installedAt` alone: the install
      // is the same.
      second = await placeFixturePlugin(pluginsRoot(), { entry: 'index', slug: SLUG, build: SECOND_BUILD });
      await db().plugin.update({
        where: { id: plugin.pluginId },
        data: {
          version: second.version,
          manifestJson: storedManifest(second),
          installedSha256: second.sha256,
          restartRequired: true,
        },
      });
    });

    it('keeps serving after an update is activated, until it restarts', async () => {
      const served = await searchBothWays();
      expect(served.coordinator).toEqual(theGameThenDone(FIRST_BUILD));
      expect(served.gateway).toEqual(theGameThenDone(FIRST_BUILD));

      await expect(isLoadedForTheGatewayWorker()).resolves.toBe(true);
      await expect(searchThroughTheHeldDriver()).resolves.toEqual(theGameThenDone(FIRST_BUILD));

      // The copy in memory is the first build, and so are the answers on the row.
      await expect(db().dataGateway.findUniqueOrThrow({ where: { id: plugin.gatewayId } })).resolves.toMatchObject({
        gatewayVersion: FIRST_BUILD.version,
        fetchGamesMaxIds: FIRST_BUILD.fetchGamesMaxIds,
      });
    });

    it("after an update's restart, the gateway worker's relay driver reaches the new version, and the DataGateway is interviewed again for it (#1083)", async () => {
      await coordinator().restart();

      // The driver the gateway worker held all along, at the address it has.
      await expect(searchThroughTheHeldDriver()).resolves.toEqual(theGameThenDone(SECOND_BUILD));

      // The coordinator built its driver from the new copy for that call, and
      // found the copy reports another version than the row's answers were
      // stored for. It interviews again in the background, so the row is
      // waited for.
      const row = await pollUntil(
        async () => {
          const current = await db().dataGateway.findUniqueOrThrow({ where: { id: plugin.gatewayId } });

          return current.gatewayVersion === SECOND_BUILD.version ? current : undefined;
        },
        { description: `DataGateway ${plugin.gatewayId}'s row to hold the answers of version ${SECOND_BUILD.version}` },
      );
      expect(row.fetchGamesMaxIds).toBe(SECOND_BUILD.fetchGamesMaxIds);

      // The restart loaded the plugin artifact the row names now, for the same install.
      await expect(db().pluginProcessLoad.findMany({ where: { slug: SLUG } })).resolves.toEqual([
        expect.objectContaining({ sha256: second.sha256, installedAt, ready: true }),
      ]);
      await expect(db().plugin.findUniqueOrThrow({ where: { id: plugin.pluginId } })).resolves.toMatchObject({
        version: SECOND_BUILD.version,
        installedAt,
        restartRequired: false,
      });
    });
  });

  // Last in the file: it leaves the coordinator stopped. A coordinator that
  // left its records behind would have the gateway worker dial an address
  // nothing answers at, and count each failure against the DataGateway.
  it('after a clean shutdown the relay source reports not loaded (#1083)', async () => {
    await expect(isLoadedForTheGatewayWorker()).resolves.toBe(true);

    await coordinator().stop();

    await expect(isLoadedForTheGatewayWorker()).resolves.toBe(false);
    await expect(db().pluginProcessLoad.findMany({ where: { slug: SLUG } })).resolves.toEqual([]);
  });
});
