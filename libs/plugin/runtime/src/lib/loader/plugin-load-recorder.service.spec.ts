import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginArtifactSha256 as sha } from '@boardgamesempire/plugin-contract';
import { Logger } from '@nestjs/common';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import {
  PLUGIN_LOAD_HEARTBEAT_MS,
  PLUGIN_LOAD_SHUTDOWN_WAIT_MS,
  PluginLoadRecorder,
} from './plugin-load-recorder.service';

describe('PluginLoadRecorder', () => {
  const installedAt = new Date('2026-10-01T00:00:00Z');

  let db: MockDatabaseService;
  let scope: { run: jest.Mock };
  let recorder: PluginLoadRecorder;

  /** Holds the next upsert open until the returned function releases it. */
  const holdNextUpsert = (): (() => void) => {
    let release!: () => void;
    db.pluginProcessLoad.upsert.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(undefined as never))) as never,
    );

    return () => release();
  };

  /** Lets every promise that can move on do so. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

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

  it('refreshes every minute (#1094)', () => {
    expect(PLUGIN_LOAD_HEARTBEAT_MS).toBe(60_000);
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
    await recorder.record('demo-sink', sha('a'), installedAt);

    expect(db.pluginProcessLoad.upsert).toHaveBeenCalledTimes(1);
    expect(db.pluginProcessLoad.upsert).toHaveBeenCalledWith({
      where: { processId_slug: { processId: recorder.processId, slug: 'demo-sink' } },
      create: {
        processId: recorder.processId,
        processRole: 'api',
        slug: 'demo-sink',
        sha256: sha('a'),
        installedAt,
        ready: false,
        loadedAt: expect.any(Date),
        heartbeatAt: expect.any(Date),
      },
      update: {
        processRole: 'api',
        sha256: sha('a'),
        installedAt,
        ready: false,
        loadedAt: expect.any(Date),
        heartbeatAt: expect.any(Date),
      },
    });
  });

  describe('readiness (#1083)', () => {
    /** The `ready` each upsert wrote, in order. */
    const readiness = () => db.pluginProcessLoad.upsert.mock.calls.map(([args]) => args.create.ready);

    it('records a load as not ready, and ready once the loader says so (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');

      expect(readiness()).toEqual([false, true]);
      expect(db.pluginProcessLoad.upsert).toHaveBeenLastCalledWith({
        where: { processId_slug: { processId: recorder.processId, slug: 'demo-sink' } },
        create: expect.objectContaining({ slug: 'demo-sink', sha256: sha('a'), installedAt, ready: true }),
        update: expect.objectContaining({ sha256: sha('a'), installedAt, ready: true }),
      });
    });

    it('keeps the original load time when it marks a load ready (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');

      const [recorded, marked] = db.pluginProcessLoad.upsert.mock.calls.map(([args]) => args.create.loadedAt);
      expect(marked).toBe(recorded);
    });

    it('writes nothing for a plugin it never recorded (#1083)', async () => {
      await recorder.markReady('demo-sink');

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });

    it('a failed readiness write rejects, and the next heartbeat writes it again though every row refreshes (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      db.pluginProcessLoad.upsert.mockRejectedValueOnce(new Error('db blip'));
      await expect(recorder.markReady('demo-sink')).rejects.toThrow('db blip');
      db.pluginProcessLoad.upsert.mockClear();
      // The row is there, holding the `ready: false` the record wrote.
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });

      await recorder.heartbeat();

      expect(readiness()).toEqual([true]);
    });

    it('rewrites only once after a failed write, while every row refreshes (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      db.pluginProcessLoad.upsert.mockRejectedValueOnce(new Error('db blip'));
      await expect(recorder.markReady('demo-sink')).rejects.toThrow('db blip');
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });
      await recorder.heartbeat();
      db.pluginProcessLoad.upsert.mockClear();

      await recorder.heartbeat();

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });

    it('a load marked ready while a rewrite is writing its row is written again by the next heartbeat (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      db.pluginProcessLoad.upsert.mockClear();
      // The row has gone missing, so this heartbeat rewrites it; its write
      // is held open, carrying the `ready: false` memory held when it began.
      let release!: () => void;
      db.pluginProcessLoad.upsert.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(undefined as never))) as never,
      );
      const rewriting = recorder.heartbeat();
      await new Promise((resolve) => setImmediate(resolve));
      expect(readiness()).toEqual([false]);

      // The ready write lands first, then the held rewrite lands over it.
      await recorder.markReady('demo-sink');
      release();
      await rewriting;
      db.pluginProcessLoad.upsert.mockClear();
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });

      await recorder.heartbeat();

      expect(readiness()).toEqual([true]);
    });

    it('a rewrite that reaches a record after it was marked ready writes it ready (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      db.pluginProcessLoad.upsert.mockClear();
      // markReady sets memory before its write, which is held open; a
      // rewrite starting then reads the record from memory.
      let release!: () => void;
      db.pluginProcessLoad.upsert.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(undefined as never))) as never,
      );
      const marking = recorder.markReady('demo-sink');

      await recorder.heartbeat();
      release();
      await marking;

      expect(readiness()).toEqual([true, true]);
    });

    it('a failed rewrite of a failed write is tried again by the next heartbeat (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      db.pluginProcessLoad.upsert.mockRejectedValueOnce(new Error('db blip'));
      await expect(recorder.markReady('demo-sink')).rejects.toThrow('db blip');
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });
      db.pluginProcessLoad.upsert.mockClear();
      db.pluginProcessLoad.upsert.mockRejectedValueOnce(new Error('db down'));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await recorder.heartbeat();
      await recorder.heartbeat();

      expect(readiness()).toEqual([true, true]);
      error.mockRestore();
    });

    it('a tick that finds a rewrite under way refreshes the heartbeat and skips the rewrite (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      db.pluginProcessLoad.upsert.mockClear();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const release = holdNextUpsert();
      const first = recorder.heartbeat();

      try {
        await settle();

        await recorder.heartbeat();

        // The refresh ran twice; the only rewrite write is the first tick's.
        expect(db.pluginProcessLoad.updateMany).toHaveBeenCalledTimes(2);
        expect(db.pluginProcessLoad.upsert).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('still under way'));
      } finally {
        release();
        await first;
        warn.mockRestore();
      }
    });

    it("a tick still refreshes the heartbeat while an earlier tick's rewrite never settles (#1083)", async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      // A rewrite stuck on a half-open connection.
      db.pluginProcessLoad.upsert.mockImplementationOnce(() => new Promise(() => undefined) as never);

      try {
        void recorder.heartbeat();
        await settle();

        await recorder.heartbeat();
        await recorder.heartbeat();

        expect(db.pluginProcessLoad.updateMany).toHaveBeenCalledTimes(3);
      } finally {
        warn.mockRestore();
      }
    });

    it('a rewrite needed while one is under way runs on a later tick once the first has finished (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      try {
        const release = holdNextUpsert();
        const first = recorder.heartbeat();
        await settle();
        // Rows missing again (count 0): a rewrite is needed, and one is running.
        await recorder.heartbeat();
        release();
        await first;
        db.pluginProcessLoad.upsert.mockClear();
        // Every row refreshes now, so only the need left pending can ask for it.
        db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });

        await recorder.heartbeat();

        expect(db.pluginProcessLoad.upsert).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('a load recorded again while a rewrite is writing its row is written again by the next heartbeat (#1083)', async () => {
      const reinstalledAt = new Date('2026-11-02T00:00:00Z');
      await recorder.record('demo-sink', sha('a'), installedAt);
      // The rewrite's write of the first record is held open.
      const release = holdNextUpsert();
      const rewriting = recorder.heartbeat();
      await settle();

      await recorder.record('demo-sink', sha('b'), reinstalledAt);
      release();
      await rewriting;
      db.pluginProcessLoad.upsert.mockClear();
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });

      await recorder.heartbeat();

      expect(db.pluginProcessLoad.upsert).toHaveBeenCalledTimes(1);
      expect(db.pluginProcessLoad.upsert.mock.calls[0][0].create).toEqual(
        expect.objectContaining({ sha256: sha('b'), installedAt: reinstalledAt, ready: false }),
      );
    });
  });

  // The coordinator loads its plugins in Nest's bootstrap hooks, which run
  // before its gRPC server listens; a gateway worker that read a ready record
  // then would dial nothing and count the failure (#1083).
  describe('a host that says when it serves (#1083)', () => {
    const readiness = () => db.pluginProcessLoad.upsert.mock.calls.map(([args]) => args.create.ready);
    const updatedReadiness = () => db.pluginProcessLoad.upsert.mock.calls.map(([args]) => args.update.ready);

    beforeEach(() => {
      recorder = new PluginLoadRecorder(
        db as unknown as DatabaseService,
        scope as unknown as SystemActorScope,
        buildPluginModuleOptions({ processRole: 'coordinator', readyOnceServing: true }),
      );
    });

    it('writes a load marked ready as not ready until the host serves (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');

      expect(readiness()).toEqual([false, false]);
      expect(updatedReadiness()).toEqual([false, false]);
    });

    it('writes the loads already marked ready as ready once the host serves, and no other (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');
      await recorder.record('half-loaded', sha('b'), installedAt);
      db.pluginProcessLoad.upsert.mockClear();

      await recorder.markServing();

      expect(db.pluginProcessLoad.upsert).toHaveBeenCalledTimes(1);
      expect(db.pluginProcessLoad.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { processId_slug: { processId: recorder.processId, slug: 'demo-sink' } },
          create: expect.objectContaining({ ready: true }),
          update: expect.objectContaining({ ready: true }),
        }),
      );
    });

    it('writes a load marked ready after the host serves as ready at once (#1083)', async () => {
      await recorder.markServing();
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');

      expect(readiness()).toEqual([false, true]);
    });

    it('a heartbeat rewrite before the host serves keeps a ready load not ready, and one after writes it ready (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');
      db.pluginProcessLoad.upsert.mockClear();
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 0 });

      await recorder.heartbeat();
      expect(readiness()).toEqual([false]);

      await recorder.markServing();
      db.pluginProcessLoad.upsert.mockClear();
      await recorder.heartbeat();

      expect(readiness()).toEqual([true]);
    });

    it('logs a failed write and resolves, and the next heartbeat writes it again (#1083)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');
      db.pluginProcessLoad.upsert.mockRejectedValueOnce(new Error('db blip'));

      await expect(recorder.markServing()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("plugin 'demo-sink' is served"));

      db.pluginProcessLoad.upsert.mockClear();
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });
      await recorder.heartbeat();

      expect(readiness()).toEqual([true]);
      error.mockRestore();
    });

    it('writes nothing once the records are withdrawn (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');
      await recorder.withdrawLoadRecords();
      db.pluginProcessLoad.upsert.mockClear();

      await recorder.markServing();

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });

    it('writes nothing on a second call (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');
      await recorder.markServing();
      db.pluginProcessLoad.upsert.mockClear();

      await recorder.markServing();

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });
  });

  it('a host that says nothing of when it serves writes a load ready as soon as it is marked, and markServing() writes nothing (#1083)', async () => {
    await recorder.record('demo-sink', sha('a'), installedAt);
    await recorder.markReady('demo-sink');
    db.pluginProcessLoad.upsert.mockClear();

    await recorder.markServing();

    expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
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
    /** The upserts the heartbeat made, as (slug, sha256, installedAt, ready, loadedAt, heartbeatAt). */
    const rewrites = () =>
      db.pluginProcessLoad.upsert.mock.calls.map(([args]) => ({
        slug: args.where.processId_slug?.slug,
        sha256: args.create.sha256,
        installedAt: args.create.installedAt,
        ready: args.create.ready,
        loadedAt: args.create.loadedAt,
        heartbeatAt: args.create.heartbeatAt,
      }));

    it('is written again by the heartbeat, with its original load time, when fewer rows refresh than were recorded', async () => {
      const otherInstalledAt = new Date('2026-10-02T00:00:00Z');
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.record('other-sink', sha('b'), otherInstalledAt);
      await recorder.markReady('other-sink');
      const [first, second] = rewrites();
      db.pluginProcessLoad.upsert.mockClear();
      // A sweep deleted one row as stale while the database was out of reach.
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });

      await recorder.heartbeat();

      // The install marker and readiness come back with the row (#1083).
      expect(rewrites()).toEqual([
        {
          slug: 'demo-sink',
          sha256: sha('a'),
          installedAt,
          ready: false,
          loadedAt: first.loadedAt,
          heartbeatAt: expect.any(Date),
        },
        {
          slug: 'other-sink',
          sha256: sha('b'),
          installedAt: otherInstalledAt,
          ready: true,
          loadedAt: second.loadedAt,
          heartbeatAt: expect.any(Date),
        },
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
      await expect(recorder.record('demo-sink', sha('a'), installedAt)).rejects.toThrow('db blip');

      await recorder.heartbeat();

      expect(rewrites()).toEqual([
        expect.anything(),
        {
          slug: 'demo-sink',
          sha256: sha('a'),
          installedAt,
          ready: false,
          loadedAt: expect.any(Date),
          heartbeatAt: expect.any(Date),
        },
      ]);
    });

    it('is not written again while every row refreshes', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      db.pluginProcessLoad.upsert.mockClear();
      db.pluginProcessLoad.updateMany.mockResolvedValue({ count: 1 });

      await recorder.heartbeat();

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });

    it('is not written again once shutdown has deleted the rows', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.beforeApplicationShutdown();
      db.pluginProcessLoad.upsert.mockClear();

      await recorder.heartbeat();

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });

    it('a failed rewrite is swallowed, and the next heartbeat tries again', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
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

  // The coordinator withdraws its records before `app.close()`, which stops
  // its gRPC server before the shutdown hooks run; the hook then runs too.
  describe('withdrawing the load records ahead of shutdown (#1083)', () => {
    it("deletes this process's records once, however often it is called, the shutdown hook included (#1083)", async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);

      await recorder.withdrawLoadRecords();
      await recorder.withdrawLoadRecords();
      await recorder.beforeApplicationShutdown();

      expect(scope.run).toHaveBeenCalledWith('plugin-load-shutdown', expect.any(Function));
      expect(db.pluginProcessLoad.deleteMany).toHaveBeenCalledTimes(1);
      expect(db.pluginProcessLoad.deleteMany).toHaveBeenCalledWith({ where: { processId: recorder.processId } });
    });

    it('writes nothing after the records are withdrawn (#1083)', async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.withdrawLoadRecords();
      db.pluginProcessLoad.upsert.mockClear();

      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');
      await recorder.heartbeat();

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
      expect(db.pluginProcessLoad.updateMany).not.toHaveBeenCalled();
    });

    it('a failed delete is swallowed (#1083)', async () => {
      db.pluginProcessLoad.deleteMany.mockRejectedValue(new Error('db down'));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      try {
        await expect(recorder.withdrawLoadRecords()).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
      } finally {
        error.mockRestore();
      }
    });
  });

  // A process that reads these rows takes a fresh one as loaded, and no
  // process is left to repair one that outlives a clean shutdown.
  describe('once shutdown begins (#1083)', () => {
    /** What the database saw, in order: each upsert landing and the delete. */
    let seen: string[];

    beforeEach(() => {
      seen = [];
      db.pluginProcessLoad.deleteMany.mockImplementation((() => {
        seen.push('delete');
        return Promise.resolve({ count: 1 });
      }) as never);
    });

    /** Holds the next upsert open, and notes when it lands. */
    const holdAndNote = (): (() => void) => {
      let release!: () => void;
      db.pluginProcessLoad.upsert.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => {
              seen.push('upsert landed');
              resolve(undefined as never);
            };
          }) as never,
      );

      return () => release();
    };

    it("waits for a record's write in flight before it deletes the rows, so none outlives a clean shutdown (#1083)", async () => {
      const release = holdAndNote();
      const recording = recorder.record('demo-sink', sha('a'), installedAt);
      const stopping = recorder.beforeApplicationShutdown();
      await settle();
      expect(seen).toEqual([]);

      release();
      await recording;
      await stopping;

      expect(seen).toEqual(['upsert landed', 'delete']);
    });

    it("waits for a heartbeat's rewrite in flight before it deletes the rows (#1083)", async () => {
      await recorder.record('demo-sink', sha('a'), installedAt);
      const release = holdAndNote();
      const ticking = recorder.heartbeat();
      await settle();
      const stopping = recorder.beforeApplicationShutdown();
      await settle();
      expect(seen).toEqual([]);

      release();
      await ticking;
      await stopping;

      expect(seen).toEqual(['upsert landed', 'delete']);
    });

    it('writes nothing for a record() or markReady() after shutdown began (#1083)', async () => {
      await recorder.beforeApplicationShutdown();

      await recorder.record('demo-sink', sha('a'), installedAt);
      await recorder.markReady('demo-sink');

      expect(db.pluginProcessLoad.upsert).not.toHaveBeenCalled();
    });

    it('a heartbeat after shutdown began touches nothing (#1083)', async () => {
      await recorder.beforeApplicationShutdown();

      await recorder.heartbeat();

      expect(db.pluginProcessLoad.updateMany).not.toHaveBeenCalled();
    });

    it('stops waiting for a write that never settles, deletes the rows and says so (#1083)', async () => {
      jest.useFakeTimers();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      db.pluginProcessLoad.upsert.mockImplementationOnce(() => new Promise(() => undefined) as never);
      void recorder.record('demo-sink', sha('a'), installedAt);

      try {
        const stopping = recorder.beforeApplicationShutdown();
        await jest.advanceTimersByTimeAsync(PLUGIN_LOAD_SHUTDOWN_WAIT_MS);
        await stopping;

        expect(seen).toEqual(['delete']);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('plugin load record'));
      } finally {
        warn.mockRestore();
        jest.useRealTimers();
      }
    });

    it('waits at most five seconds (#1083)', () => {
      expect(PLUGIN_LOAD_SHUTDOWN_WAIT_MS).toBe(5_000);
    });
  });
});
