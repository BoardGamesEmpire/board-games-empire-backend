import { PluginCategory } from '@bge/database';
import { PluginInventoryService, type RunningServerPlugin } from '@bge/plugin';
import { createTestingModuleWithDb } from '@bge/testing';
import { SERVER_DISCOVERY_SCHEMA_VERSION } from './constants';
import { ServerDiscoveryService } from './server-discovery.service';

/**
 * The complete set of top-level keys signed-in server discovery is documented
 * to expose (#78). Adding a field to ServerDiscoveryDto without updating this
 * list, or the reverse, fails the shape lock below.
 */
const DOCUMENTED_KEYS = ['discoverySchemaVersion', 'coreAreas', 'serverPlugins'].sort();

/**
 * The core areas this server ships today (#78). A key is added when a core
 * area ships (plays, chat, push), never by an admin switch.
 */
const DOCUMENTED_CORE_AREA_KEYS = ['events', 'friendships', 'households'].sort();

describe('ServerDiscoveryService (#78)', () => {
  let service: ServerDiscoveryService;
  let inventory: { listRunningOnServer: jest.Mock<Promise<RunningServerPlugin[]>, [string?]> };

  beforeEach(async () => {
    inventory = { listRunningOnServer: jest.fn().mockResolvedValue([]) };

    const { module } = await createTestingModuleWithDb({
      providers: [ServerDiscoveryService, { provide: PluginInventoryService, useValue: inventory }],
    });

    service = module.get(ServerDiscoveryService);
  });

  it('exposes exactly the documented top-level keys', async () => {
    const discovery = await service.getServerDiscovery();

    expect(Object.keys(discovery).sort()).toEqual(DOCUMENTED_KEYS);
  });

  it('reports schema version 1', async () => {
    const discovery = await service.getServerDiscovery();

    expect(SERVER_DISCOVERY_SCHEMA_VERSION).toBe(1);
    expect(discovery.discoverySchemaVersion).toBe(1);
  });

  it('advertises exactly the shipped core areas, each on', async () => {
    const { coreAreas } = await service.getServerDiscovery();

    expect(Object.keys(coreAreas).sort()).toEqual(DOCUMENTED_CORE_AREA_KEYS);
    expect(Object.values(coreAreas).every((offered) => offered === true)).toBe(true);
  });

  it('maps running plugins to slug, category and display name, in the order read', async () => {
    inventory.listRunningOnServer.mockResolvedValue([
      { slug: 'a', category: PluginCategory.DataGateway, displayName: 'A' },
      { slug: 'b', category: PluginCategory.FeedbackSink, displayName: 'B' },
    ]);

    const { serverPlugins } = await service.getServerDiscovery();

    expect(serverPlugins).toEqual([
      { slug: 'a', category: PluginCategory.DataGateway, displayName: 'A' },
      { slug: 'b', category: PluginCategory.FeedbackSink, displayName: 'B' },
    ]);
  });

  it('passes the request locale through to the plugin read', async () => {
    await service.getServerDiscovery('de');

    expect(inventory.listRunningOnServer).toHaveBeenCalledWith('de');
  });

  it('returns an empty plugin list when none is running', async () => {
    const { serverPlugins } = await service.getServerDiscovery();

    expect(serverPlugins).toEqual([]);
  });
});
