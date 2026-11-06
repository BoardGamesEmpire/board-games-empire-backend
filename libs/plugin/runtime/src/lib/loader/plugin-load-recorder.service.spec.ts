import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginArtifactSha256 as sha } from '@boardgamesempire/plugin-contract';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import { PLUGIN_LOAD_HEARTBEAT_MS, PLUGIN_LOAD_STALE_MS, PluginLoadRecorder } from './plugin-load-recorder.service';

describe('PluginLoadRecorder', () => {
  let db: MockDatabaseService;
  let scope: { run: jest.Mock };
  let recorder: PluginLoadRecorder;

  beforeEach(() => {
    db = createMockDatabaseService();
    scope = { run: jest.fn(<T>(_reason: string, fn: () => T): T => fn()) };
    recorder = new PluginLoadRecorder(
      db as unknown as DatabaseService,
      scope as unknown as SystemActorScope,
      buildPluginModuleOptions({ processRole: 'api' }),
    );
  });

  it('refreshes every minute and calls a record stale after five (#1094)', () => {
    expect(PLUGIN_LOAD_HEARTBEAT_MS).toBe(60_000);
    expect(PLUGIN_LOAD_STALE_MS).toBe(5 * 60_000);
  });

  it('gives each recorder its own process id (#1094)', () => {
    const other = new PluginLoadRecorder(
      db as unknown as DatabaseService,
      scope as unknown as SystemActorScope,
      buildPluginModuleOptions(),
    );

    expect(recorder.processId).toEqual(expect.any(String));
    expect(recorder.processId).not.toBe(other.processId);
  });

  it('records the artifact a plugin was loaded from, with this process and its role (#1094)', async () => {
    await recorder.record('demo-sink', sha('a'));

    expect(db.pluginProcessLoad.upsert).toHaveBeenCalledTimes(1);
    expect(db.pluginProcessLoad.upsert).toHaveBeenCalledWith({
      where: { processId_slug: { processId: recorder.processId, slug: 'demo-sink' } },
      create: { processId: recorder.processId, processRole: 'api', slug: 'demo-sink', sha256: sha('a') },
      update: {
        processRole: 'api',
        sha256: sha('a'),
        loadedAt: expect.any(Date),
        heartbeatAt: expect.any(Date),
      },
    });
  });

  it("the heartbeat touches only this process's records (#1094)", async () => {
    await recorder.heartbeat();

    expect(scope.run).toHaveBeenCalledWith('plugin-load-heartbeat', expect.any(Function));
    expect(db.pluginProcessLoad.updateMany).toHaveBeenCalledWith({
      where: { processId: recorder.processId },
      data: { heartbeatAt: expect.any(Date) },
    });
  });

  it('a failed heartbeat is swallowed so the scheduler survives it (#1094)', async () => {
    db.pluginProcessLoad.updateMany.mockRejectedValue(new Error('db down'));

    await expect(recorder.heartbeat()).resolves.toBeUndefined();
  });

  it("a clean shutdown deletes this process's records (#1094)", async () => {
    await recorder.beforeApplicationShutdown();

    expect(scope.run).toHaveBeenCalledWith('plugin-load-shutdown', expect.any(Function));
    expect(db.pluginProcessLoad.deleteMany).toHaveBeenCalledWith({ where: { processId: recorder.processId } });
  });

  it('a failed shutdown delete is swallowed so the other shutdown hooks still run (#1094)', async () => {
    db.pluginProcessLoad.deleteMany.mockRejectedValue(new Error('db down'));

    await expect(recorder.beforeApplicationShutdown()).resolves.toBeUndefined();
  });
});
