import { PluginCategory } from '../client';
import { hasLivePluginLoad, PLUGIN_LOAD_STALE_MS, roleLoading } from './plugin-load';
import type { PluginLoadRecordRow } from './plugin-load.fixtures';
import { fakePluginLoadRecords } from './plugin-load.fixtures';

describe('hasLivePluginLoad', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const installedAt = new Date('2026-11-01T00:00:00Z');
  const plugin = { slug: 'demo-gateway', installedAt };
  const ago = (ms: number): Date => new Date(now.getTime() - ms);

  const table = fakePluginLoadRecords();
  const findFirst = jest.fn(table.findFirst);
  const db = { pluginProcessLoad: { findFirst } } as unknown as Parameters<typeof hasLivePluginLoad>[0];

  const record = (overrides: Partial<PluginLoadRecordRow> = {}): PluginLoadRecordRow => ({
    slug: 'demo-gateway',
    processRole: 'coordinator',
    installedAt,
    ready: true,
    heartbeatAt: ago(60_000),
    ...overrides,
  });

  beforeEach(() => {
    table.rows = [];
    findFirst.mockClear();
  });

  it('is true for a ready record of this process role that names the install, with a fresh heartbeat (#1083)', async () => {
    table.rows = [record()];

    await expect(hasLivePluginLoad(db, plugin, 'coordinator', now)).resolves.toBe(true);
  });

  it('is false when the heartbeat is older than the window (#1083)', async () => {
    table.rows = [record({ heartbeatAt: ago(PLUGIN_LOAD_STALE_MS + 1) })];

    await expect(hasLivePluginLoad(db, plugin, 'coordinator', now)).resolves.toBe(false);
  });

  // The artifact sweep deletes a record whose heartbeat is this old or
  // older, so a record it would delete must not read as live, and one it
  // still honours must.
  it('agrees with the artifact sweep on which side of the window its edge falls (#1083)', async () => {
    table.rows = [record({ heartbeatAt: ago(PLUGIN_LOAD_STALE_MS) })];
    await expect(hasLivePluginLoad(db, plugin, 'coordinator', now)).resolves.toBe(false);

    table.rows = [record({ heartbeatAt: ago(PLUGIN_LOAD_STALE_MS - 1) })];
    await expect(hasLivePluginLoad(db, plugin, 'coordinator', now)).resolves.toBe(true);
  });

  it('is false when the record names another install, as after a reinstall (#1083)', async () => {
    table.rows = [record({ installedAt: new Date('2026-10-01T00:00:00Z') })];

    await expect(hasLivePluginLoad(db, plugin, 'coordinator', now)).resolves.toBe(false);
  });

  it('is false with no record (#1083)', async () => {
    await expect(hasLivePluginLoad(db, plugin, 'coordinator', now)).resolves.toBe(false);
  });

  it('is false for a record of a load that is under way or failed (#1083)', async () => {
    table.rows = [record({ ready: false })];

    await expect(hasLivePluginLoad(db, plugin, 'coordinator', now)).resolves.toBe(false);
  });

  it("is false when only another process role's record names the install, as after an update into data-gateway (#1083)", async () => {
    table.rows = [record({ processRole: 'api' })];

    await expect(hasLivePluginLoad(db, plugin, 'coordinator', now)).resolves.toBe(false);
  });

  it('asks the database once (#1083)', async () => {
    table.rows = [record()];

    await hasLivePluginLoad(db, plugin, 'coordinator', now);

    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  // Both sides, so a default far in the past (everything live) or far in the
  // future (nothing live) fails.
  it('measures the window from the current time when none is given (#1083)', async () => {
    const current = Date.now();

    table.rows = [record({ heartbeatAt: new Date(current - PLUGIN_LOAD_STALE_MS - 60_000) })];
    await expect(hasLivePluginLoad(db, plugin, 'coordinator')).resolves.toBe(false);

    table.rows = [record({ heartbeatAt: new Date(current) })];
    await expect(hasLivePluginLoad(db, plugin, 'coordinator')).resolves.toBe(true);
  });
});

describe('roleLoading', () => {
  it('names the coordinator for a data-gateway plugin (#1083)', () => {
    expect(roleLoading(PluginCategory.DataGateway)).toBe('coordinator');
  });

  it.each(Object.values(PluginCategory).filter((category) => category !== PluginCategory.DataGateway))(
    'names the api for a %s plugin (#1083)',
    (category) => {
      expect(roleLoading(category)).toBe('api');
    },
  );
});

describe('PLUGIN_LOAD_STALE_MS', () => {
  it('is five missed heartbeats of a minute (#1094)', () => {
    expect(PLUGIN_LOAD_STALE_MS).toBe(5 * 60_000);
  });
});
