import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginArtifactSha256 as sha } from '@boardgamesempire/plugin-contract';
import { Logger } from '@nestjs/common';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import { PLUGIN_LOAD_HEARTBEAT_MS, PLUGIN_LOAD_STALE_MS, PluginLoadRecorder } from './plugin-load-recorder.service';

describe('PluginLoadRecorder', () => {
  let db: MockDatabaseService;
  let scope: { run: jest.Mock };
  let recorder: PluginLoadRecorder;

  beforeEach(() => {
    db = createMockDatabaseService();
    scope = { run: jest.fn(<T>(_reason: string, fn: () => T): T => fn()) };
    db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 0 });
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
      create: {
        processId: recorder.processId,
        processRole: 'api',
        slug: 'demo-sink',
        sha256: sha('a'),
        loadedAt: expect.any(Date),
        heartbeatAt: expect.any(Date),
      },
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

  describe('a record that has gone missing (#1094)', () => {
    /** The upserts the heartbeat made, as (slug, sha256, loadedAt, heartbeatAt). */
    const rewrites = () =>
      db.pluginProcessLoad.upsert.mock.calls.map(([args]) => ({
        slug: args.where.processId_slug?.slug,
        sha256: args.create.sha256,
        loadedAt: args.create.loadedAt,
        heartbeatAt: args.create.heartbeatAt,
      }));

    it('is written again by the heartbeat, with its original load time, when fewer rows refresh than were recorded', async () => {
      await recorder.record('demo-sink', sha('a'));
      await recorder.record('other-sink', sha('b'));
      const [first, second] = rewrites();
      db.pluginProcessLoad.upsert.mockClear();
      // A sweep deleted one row as stale while the database was out of reach.
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });

      await recorder.heartbeat();

      expect(rewrites()).toEqual([
        { slug: 'demo-sink', sha256: sha('a'), loadedAt: first.loadedAt, heartbeatAt: expect.any(Date) },
        { slug: 'other-sink', sha256: sha('b'), loadedAt: second.loadedAt, heartbeatAt: expect.any(Date) },
      ]);
      const [{ heartbeatAt }] = rewrites();
      expect(db.pluginProcessLoad.updateMany).toHaveBeenCalledWith({
        where: { processId: recorder.processId },
        data: { heartbeatAt },
      });
      expect(scope.run).toHaveBeenCalledWith('plugin-load-heartbeat', expect.any(Function));
    });

    it('is written by the next heartbeat when its first write failed', async () => {
      db.pluginProcessLoad.upsert.mockRejectedValueOnce(new Error('db blip'));
      await expect(recorder.record('demo-sink', sha('a'))).rejects.toThrow('db blip');

      await recorder.heartbeat();

      expect(rewrites()).toEqual([
        expect.anything(),
        { slug: 'demo-sink', sha256: sha('a'), loadedAt: expect.any(Date), heartbeatAt: expect.any(Date) },
      ]);
    });

    it('is not written again while every row refreshes', async () => {
      await recorder.record('demo-sink', sha('a'));
      db.pluginProcessLoad.upsert.mockClear();
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });

      await recorder.heartbeat();

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });

    it('is not written again once shutdown has deleted the rows', async () => {
      await recorder.record('demo-sink', sha('a'));
      await recorder.beforeApplicationShutdown();
      db.pluginProcessLoad.upsert.mockClear();

      await recorder.heartbeat();

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });

    it('a failed rewrite is swallowed, and the next heartbeat tries again', async () => {
      await recorder.record('demo-sink', sha('a'));
      db.pluginProcessLoad.upsert.mockClear();
      db.pluginProcessLoad.upsert.mockRejectedValueOnce(new Error('db down'));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await expect(recorder.heartbeat()).resolves.toBeUndefined();
      await recorder.heartbeat();

      expect(db.pluginProcessLoad.upsert).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
      error.mockRestore();
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
