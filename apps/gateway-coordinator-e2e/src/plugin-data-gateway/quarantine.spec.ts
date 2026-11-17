import { status } from '@grpc/grpc-js';
import { useCoordinator } from '../support/coordinator';
import type { SeededPlugin } from '../support/plugin-on-disk';
import { clearPluginRows, placeFixturePlugin, seedPluginRows, usePluginsRoot } from '../support/plugin-on-disk';
import { readRoutedPlugin, useRelaySource } from '../support/relay-source';
import { useTestDatabase } from '../support/test-db';

const SLUG = 'not-a-factory-gateway';

/**
 * A data-gateway plugin's factory returns a driver factory, the function the
 * server calls each time it needs a new driver (#1083). The coordinator
 * checks that when it loads the plugin. One whose factory returns anything
 * else is quarantined, and the coordinator boots on without it.
 */
describe('a data-gateway plugin whose factory returns no driver factory', () => {
  const db = useTestDatabase();
  const pluginsRoot = usePluginsRoot();

  let plugin: SeededPlugin;

  // Before the coordinator launches: what it loads is decided when it boots.
  beforeAll(async () => {
    await clearPluginRows(db());
    plugin = await seedPluginRows(
      db(),
      await placeFixturePlugin(pluginsRoot(), { entry: 'not-a-factory', slug: SLUG }),
    );
  });

  const coordinator = useCoordinator({ pluginsRoot });
  const relay = useRelaySource(coordinator);

  it("quarantines a plugin whose product isn't a driver factory (#1083)", async () => {
    await expect(db().plugin.findUniqueOrThrow({ where: { id: plugin.pluginId } })).resolves.toMatchObject({
      enabled: false,
      loadFailed: true,
      loadError: expect.stringContaining('must return a driver factory function'),
    });

    await expect(coordinator().service.check()).resolves.toEqual({ status: 'SERVING' });

    await expect(coordinator().service.reinterviewGateway(plugin.gatewayId)).resolves.toMatchObject({
      success: false,
      refusalReason: 'plugin_not_served',
    });
    await expect(coordinator().service.searchGames(plugin.gatewayId, 'a quarantined plugin')).resolves.toEqual([
      expect.objectContaining({
        status: 'RESULT_STATUS_UNAVAILABLE',
        message: expect.stringContaining('failed to load'),
      }),
    ]);
    await expect(
      coordinator().gateway({ gatewayId: plugin.gatewayId }).searchGames('a quarantined plugin'),
    ).rejects.toMatchObject({ code: status.FAILED_PRECONDITION });
  });

  // The load is recorded before the plugin's directory is read, so that the
  // artifact sweep keeps the directory, and the record outlives a load that
  // fails. The gateway worker reads these records to learn whether a plugin
  // is loaded, so the record must not say that it is.
  it('never lets a failed load read as loaded (#1083)', async () => {
    await expect(db().pluginProcessLoad.findMany({ where: { slug: SLUG } })).resolves.toEqual([
      expect.objectContaining({ processRole: 'coordinator', installedAt: plugin.installedAt, ready: false }),
    ]);

    await expect(relay().isLoaded(await readRoutedPlugin(db(), plugin.pluginId))).resolves.toBe(false);
  });
});
