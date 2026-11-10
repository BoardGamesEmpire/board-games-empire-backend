import type { SystemActorScope } from '@bge/actor-context';
import { buildPluginModuleOptions, PLUGIN_LOAD_STALE_MS } from '@bge/plugin';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginArtifactSha256 as sha } from '@boardgamesempire/plugin-contract';
import { Logger } from '@nestjs/common';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginArtifactStore } from '../store/plugin-artifact.store';
import { INCOMING_DIRNAME } from '../workspace/incoming';
import {
  PLUGIN_ARTIFACT_SWEEP_GRACE_MS,
  PLUGIN_ARTIFACT_SWEEP_INTERVAL_MS,
  PLUGIN_ARTIFACT_SWEEP_SHUTDOWN_WAIT_MS,
  PluginArtifactSweepService,
} from './plugin-artifact-sweep.service';

// The real calls, behind mocks a test can make fail for one path, or race.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    readdir: jest.fn(actual.readdir),
    rename: jest.fn(actual.rename),
    rm: jest.fn(actual.rm),
  };
});

const {
  readdir: actualReaddir,
  rename: actualRename,
  rm: actualRm,
} = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Select = Record<string, boolean>;

type ArtifactRow = { sha256: string; slug: string; expiresAt: Date };
type PluginRow = { slug: string; installedSha256: string; pendingSha256: string | null; uninstalledAt: Date | null };
type LoadRow = { processId: string; slug: string; sha256: string; heartbeatAt: Date };

/** A mocked Prisma delegate, as far as the in-memory fake below drives it. */
interface FakeableDelegate {
  findMany: { mockImplementation(fn: never): unknown };
  findUnique: { mockImplementation(fn: never): unknown };
  deleteMany: { mockImplementation(fn: never): unknown };
  updateMany: { mockImplementation(fn: never): unknown };
}

/**
 * Whether a row matches a Prisma `where` of the shapes the sweep and the
 * store send: a plain value, a date or `null` for equality, `{ lte }` or
 * `{ gt }` on a date. Any other shape throws, so the fake never quietly
 * matches a query it does not understand.
 */
const matches = (row: Row, where: Where = {}): boolean =>
  Object.entries(where).every(([column, condition]) => {
    const value = row[column];

    if (condition === null || typeof condition !== 'object') {
      return value === condition;
    }

    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }

    const { lte, gt, ...rest } = condition as { lte?: Date; gt?: Date };
    if (Object.keys(rest).length > 0 || (lte === undefined && gt === undefined) || !(value instanceof Date)) {
      throw new Error(`The fake database cannot judge ${column} against ${JSON.stringify(condition)}`);
    }

    return (
      (lte === undefined || value.getTime() <= lte.getTime()) && (gt === undefined || value.getTime() > gt.getTime())
    );
  });

/** Only the selected columns, as Prisma returns them; a column the caller did not select reads as undefined. */
const pick = (row: Row, select?: Select): Row =>
  select === undefined ? { ...row } : Object.fromEntries(Object.keys(select).map((column) => [column, row[column]]));

describe('PluginArtifactSweepService (#1094)', () => {
  /**
   * The current time in whole seconds. A directory aged to an exact boundary
   * carries it exactly, and one a test creates, or the sweep touches, is
   * younger than any cutoff the run computes from it.
   */
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  /** Well past the grace period, as a directory placed weeks ago is. */
  const AGED = 30 * 24 * HOUR;
  /** Inside the grace period, as a directory placed a minute ago is. */
  const YOUNG = MINUTE;

  let root: string;
  let db: MockDatabaseService;
  let tables: { artifacts: ArtifactRow[]; plugins: PluginRow[]; loads: LoadRow[] };
  /** What the fake database saw, in order: each delete, and each read's start and end. */
  let events: string[];
  /** Runs once a read has taken its result, before returning it: a change a test makes land there. */
  let afterRead: ((table: string) => void) | undefined;
  /** Runs as a delete starts, before it picks its rows. */
  let beforeDelete: ((table: string) => Promise<void>) | undefined;
  let store: PluginArtifactStore;
  let scope: { run: jest.Mock };
  /** The runs the scope started, so a test can wait for one it did not await. */
  let runs: Promise<unknown>[];
  let service: PluginArtifactSweepService;
  let log: jest.SpyInstance;
  let debug: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  /** Backs a mocked delegate with an in-memory table, for the queries the sweep and the store send. */
  const backWithTable = (delegate: FakeableDelegate, table: string, rows: Row[]) => {
    delegate.findMany.mockImplementation((async ({ where, select }: { where?: Where; select?: Select } = {}) => {
      events.push(`start read ${table}`);
      // A tick, so reads issued at once would show as interleaved starts.
      await Promise.resolve();
      const result = rows.filter((row) => matches(row, where)).map((row) => pick(row, select));
      events.push(`end read ${table}`);
      afterRead?.(table);
      return result;
    }) as never);
    delegate.deleteMany.mockImplementation((async ({ where }: { where?: Where } = {}) => {
      await beforeDelete?.(table);
      const doomed = rows.filter((row) => matches(row, where));
      for (const row of doomed) {
        rows.splice(rows.indexOf(row), 1);
      }
      events.push(`delete ${table}`);
      return { count: doomed.length };
    }) as never);
    delegate.updateMany.mockImplementation((async ({ where, data }: { where?: Where; data: Row }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) {
        Object.assign(row, data);
      }
      return { count: hit.length };
    }) as never);
    delegate.findUnique.mockImplementation((async ({ where }: { where: Where }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return row === undefined ? null : { ...row };
    }) as never);
  };

  const sweepWith = (pluginsRoot: string) =>
    new PluginArtifactSweepService(
      db as never,
      store,
      scope as unknown as SystemActorScope,
      buildPluginModuleOptions({ pluginsRoot }),
    );

  const artifactRow = (sha256: string, expiresAt: Date, slug = 'demo-sink'): ArtifactRow => ({
    sha256,
    slug,
    expiresAt,
  });
  const pluginRow = (fields: Partial<PluginRow> & Pick<PluginRow, 'installedSha256'>): PluginRow => ({
    slug: 'demo-sink',
    pendingSha256: null,
    uninstalledAt: null,
    ...fields,
  });
  const loadRow = (sha256: string, heartbeatAt: Date, processId = 'process-1'): LoadRow => ({
    processId,
    slug: 'demo-sink',
    sha256,
    heartbeatAt,
  });

  const ago = (ms: number): Date => new Date(now.getTime() - ms);

  /** Sets a path's mtime to `ageMs` before `now`. */
  const age = async (path: string, ageMs: number): Promise<void> => {
    await utimes(path, ago(ageMs), ago(ageMs));
  };

  /** `<root>/<slug>/<sha256>/` holding a manifest, last changed `ageMs` before `now`. */
  const artifactDirectory = async (slug: string, sha256: string, ageMs: number): Promise<string> => {
    const dir = join(root, slug, sha256);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), '{}');
    await age(dir, ageMs);
    return dir;
  };

  /** Whether the path itself is there; a link counts whatever it points to. */
  const exists = (path: string): Promise<boolean> =>
    lstat(path).then(
      () => true,
      () => false,
    );

  /** What `.incoming/` holds now. */
  const incomingEntries = async (): Promise<string[]> =>
    actualReaddir(join(root, INCOMING_DIRNAME)).catch(() => [] as string[]);

  /** Lets a run started in the background, and the handler that logs how it ended, finish. */
  const settle = async (): Promise<void> => {
    await Promise.allSettled(runs);
    await new Promise((resolve) => setImmediate(resolve));
  };

  /** Holds the sweep's first delete until the returned function is called. */
  const holdFirstDelete = (): (() => void) => {
    let release!: () => void;
    db.pluginArtifact.deleteMany.mockImplementationOnce(
      (() =>
        new Promise((resolve) => {
          release = () => resolve({ count: 0 });
        })) as never,
    );
    return () => release();
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-sweep-'));
    tables = { artifacts: [], plugins: [], loads: [] };
    events = [];
    afterRead = undefined;
    beforeDelete = undefined;
    db = createMockDatabaseService();
    backWithTable(db.pluginArtifact, 'pluginArtifact', tables.artifacts);
    backWithTable(db.plugin, 'plugin', tables.plugins);
    backWithTable(db.pluginProcessLoad, 'pluginProcessLoad', tables.loads);
    // A database that has installed a plugin, as any in use has: one
    // uninstalled plugin, which names nothing. One without a single plugin row
    // spares every artifact directory, as the guard's own tests show.
    tables.plugins.push(pluginRow({ slug: 'retired-plugin', installedSha256: sha('9'), uninstalledAt: ago(AGED) }));
    store = new PluginArtifactStore(db as never);
    runs = [];
    scope = {
      run: jest.fn((_reason: string, fn: () => unknown) => {
        const result = fn();
        runs.push(Promise.resolve(result));
        return result;
      }),
    };
    service = sweepWith(root);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    // Back to the real calls, including any once-implementation a failed test left queued.
    jest
      .mocked(readdir)
      .mockReset()
      .mockImplementation(actualReaddir as never);
    jest.mocked(rename).mockReset().mockImplementation(actualRename);
    jest.mocked(rm).mockReset().mockImplementation(actualRm);
    await rm(root, { recursive: true, force: true });
  });

  it('sweeps hourly, with a one-hour grace period, and holds up shutdown five seconds at most (#1094)', () => {
    expect(PLUGIN_ARTIFACT_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(PLUGIN_ARTIFACT_SWEEP_GRACE_MS).toBe(60 * 60 * 1000);
    expect(PLUGIN_ARTIFACT_SWEEP_SHUTDOWN_WAIT_MS).toBe(5_000);
  });

  it('keeps directories living rows, unexpired artifacts and fresh load records name (#1094)', async () => {
    tables.plugins.push(pluginRow({ installedSha256: sha('1'), pendingSha256: sha('2') }));
    tables.artifacts.push(artifactRow(sha('3'), new Date(now.getTime() + HOUR), 'other-plugin'));
    tables.loads.push(loadRow(sha('4'), ago(MINUTE)));
    const named = [
      await artifactDirectory('demo-sink', sha('1'), AGED),
      await artifactDirectory('demo-sink', sha('2'), AGED),
      await artifactDirectory('other-plugin', sha('3'), AGED),
      await artifactDirectory('demo-sink', sha('4'), AGED),
    ];
    // Nothing names this one: its removal shows the run did walk the root.
    const unnamed = await artifactDirectory('demo-sink', sha('5'), AGED);
    // Aged slug directories: one that still holds a named artifact must stay whole.
    await age(join(root, 'demo-sink'), AGED);
    await age(join(root, 'other-plugin'), AGED);

    const result = await service.runSweep(now);

    for (const dir of named) {
      expect(await exists(dir)).toBe(true);
    }
    expect(await exists(unnamed)).toBe(false);
    expect(result).toEqual({
      removedDirectories: 1,
      removedIncoming: 0,
      expiredArtifacts: 0,
      artifactsWithoutDirectory: 0,
      staleLoadRecords: 0,
    });
  });

  it('removes an aged directory nothing names, as after a crash between placement and commit (#1094)', async () => {
    const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
    await age(join(root, 'demo-sink'), AGED);

    await expect(service.runSweep(now)).resolves.toEqual({
      removedDirectories: 1,
      removedIncoming: 0,
      expiredArtifacts: 0,
      artifactsWithoutDirectory: 0,
      staleLoadRecords: 0,
    });

    expect(await exists(dir)).toBe(false);
    // The sweep never removes a slug directory, empty or not.
    expect(await exists(join(root, 'demo-sink'))).toBe(true);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining(`demo-sink/${sha('a')}`));
    // One summary line for the run.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'Plugin artifact sweep removed 1 artifact directory and 0 incoming entries, ' +
        'and deleted 0 expired artifact rows, 0 artifact rows whose directory was gone and 0 stale load records',
    );
  });

  it('keeps a young directory nothing names yet (#1094)', async () => {
    const young = await artifactDirectory('demo-sink', sha('a'), YOUNG);
    const aged = await artifactDirectory('other-plugin', sha('b'), AGED);

    await service.runSweep(now);

    expect(await exists(young)).toBe(true);
    expect(await exists(aged)).toBe(false);
  });

  it('removes a directory exactly a grace period old, and keeps one a second younger (#1094)', async () => {
    const atGrace = await artifactDirectory('demo-sink', sha('a'), PLUGIN_ARTIFACT_SWEEP_GRACE_MS);
    const younger = await artifactDirectory('demo-sink', sha('b'), PLUGIN_ARTIFACT_SWEEP_GRACE_MS - 1000);

    await service.runSweep(now);

    expect(await exists(atGrace)).toBe(false);
    expect(await exists(younger)).toBe(true);
  });

  it('removes a rejected staged directory once nothing loads it, and keeps it while a process does (#1094)', async () => {
    // The rejection cleared the staged columns, so only the load record of a
    // process that still has that code names the directory.
    tables.plugins.push(pluginRow({ installedSha256: sha('1'), pendingSha256: null }));
    tables.loads.push(loadRow(sha('2'), ago(MINUTE)));
    const installed = await artifactDirectory('demo-sink', sha('1'), AGED);
    const rejected = await artifactDirectory('demo-sink', sha('2'), AGED);

    await service.runSweep(now);

    expect(await exists(rejected)).toBe(true);

    // Ten minutes on, the process has stopped refreshing its record.
    const later = new Date(now.getTime() + 10 * MINUTE);
    await expect(service.runSweep(later)).resolves.toMatchObject({ removedDirectories: 1, staleLoadRecords: 1 });

    expect(await exists(rejected)).toBe(false);
    expect(await exists(installed)).toBe(true);
  });

  it('keeps an installing artifact whose row was refreshed during the run (#1094)', async () => {
    // Both rows expired a second before the sweep's clock. An install that
    // started two seconds earlier found its row still live, and its refresh,
    // on its own clock, lands as the sweep's first delete starts. The other
    // row has no install.
    tables.artifacts.push(artifactRow(sha('a'), ago(1000)), artifactRow(sha('b'), ago(1000)));
    const installing = await artifactDirectory('demo-sink', sha('a'), AGED);
    const abandoned = await artifactDirectory('demo-sink', sha('b'), AGED);
    let refreshed: unknown;
    beforeDelete = async (table) => {
      if (table === 'pluginArtifact' && refreshed === undefined) {
        refreshed = await store.refreshForInstall(sha('a'), ago(2000));
      }
    };

    await expect(service.runSweep(now)).resolves.toMatchObject({ expiredArtifacts: 1, removedDirectories: 1 });

    expect(refreshed).toEqual(expect.objectContaining({ sha256: sha('a') }));
    expect(tables.artifacts.map(({ sha256 }) => sha256)).toEqual([sha('a')]);
    expect(await exists(installing)).toBe(true);
    expect(await exists(abandoned)).toBe(false);
  });

  it("keeps a just-installed plugin's directory when the install lands between the sweep's reads (#1094)", async () => {
    tables.artifacts.push(artifactRow(sha('a'), new Date(now.getTime() + HOUR)));
    // Placed when the artifact was received, days ago.
    const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
    // Install commits the plugin row, then deletes the artifact row, right
    // after the artifact read of what to keep: the sweep's second artifact
    // read, after the one that looks for rows whose directory is gone. Read
    // the other way round, the sweep would find the checksum in neither table.
    let installed = false;
    let artifactReads = 0;
    afterRead = (table) => {
      if (table === 'pluginArtifact' && ++artifactReads === 2 && !installed) {
        installed = true;
        tables.plugins.push(pluginRow({ installedSha256: sha('a') }));
        tables.artifacts.splice(0);
      }
    };

    await service.runSweep(now);

    expect(installed).toBe(true);
    expect(await exists(dir)).toBe(true);
  });

  it('deletes what has lapsed or lost its directory, then reads artifact rows, plugin rows and load records one after another (#1094)', async () => {
    await service.runSweep(now);

    expect(events).toEqual([
      'delete pluginArtifact',
      'start read pluginArtifact',
      'end read pluginArtifact',
      'delete pluginProcessLoad',
      'start read pluginArtifact',
      'end read pluginArtifact',
      'start read plugin',
      'end read plugin',
      'start read pluginProcessLoad',
      'end read pluginProcessLoad',
    ]);
    // The live rows, to look for each one's directory.
    expect(db.pluginArtifact.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { gt: now } },
      select: { sha256: true, slug: true, expiresAt: true },
    });
    // Only the checksums, and on plugin rows whether each is uninstalled: a
    // plugin row's manifest is no business of the sweep.
    expect(db.pluginArtifact.findMany).toHaveBeenCalledWith({ select: { sha256: true } });
    expect(db.plugin.findMany).toHaveBeenCalledWith({
      select: { installedSha256: true, pendingSha256: true, uninstalledAt: true },
    });
    expect(db.pluginProcessLoad.findMany).toHaveBeenCalledWith({ select: { sha256: true } });
  });

  it('deletes an artifact row at its expiry instant and keeps one expiring a millisecond later (#1094)', async () => {
    tables.artifacts.push(artifactRow(sha('a'), now), artifactRow(sha('b'), new Date(now.getTime() + 1)));
    const expired = await artifactDirectory('demo-sink', sha('a'), AGED);
    const live = await artifactDirectory('demo-sink', sha('b'), AGED);

    await expect(service.runSweep(now)).resolves.toMatchObject({ expiredArtifacts: 1, removedDirectories: 1 });

    expect(tables.artifacts.map(({ sha256 }) => sha256)).toEqual([sha('b')]);
    expect(await exists(expired)).toBe(false);
    expect(await exists(live)).toBe(true);
  });

  describe('a live artifact row whose directory is gone', () => {
    it('is deleted and counted, and keeps nothing (#1094)', async () => {
      // A row is written only once its directory is placed, so this one's was
      // removed by hand.
      tables.artifacts.push(
        artifactRow(sha('a'), new Date(now.getTime() + HOUR)),
        artifactRow(sha('b'), new Date(now.getTime() + HOUR)),
      );
      const placed = await artifactDirectory('demo-sink', sha('b'), AGED);
      // The same checksum under another slug, which only a kept checksum would spare.
      const elsewhere = await artifactDirectory('other-plugin', sha('a'), AGED);

      await expect(service.runSweep(now)).resolves.toEqual({
        removedDirectories: 1,
        removedIncoming: 0,
        expiredArtifacts: 0,
        artifactsWithoutDirectory: 1,
        staleLoadRecords: 0,
      });

      expect(tables.artifacts.map(({ sha256 }) => sha256)).toEqual([sha('b')]);
      expect(await exists(placed)).toBe(true);
      expect(await exists(elsewhere)).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('1 artifact row whose directory was gone'));
    });

    it('stays when a re-post places its directory again between the look and the delete (#1094)', async () => {
      tables.artifacts.push(artifactRow(sha('a'), new Date(now.getTime() + HOUR)));
      // The second delete of an artifact row is this one: the first removes expired rows.
      let artifactDeletes = 0;
      beforeDelete = async (table) => {
        if (table === 'pluginArtifact' && ++artifactDeletes === 2) {
          await artifactDirectory('demo-sink', sha('a'), YOUNG);
          tables.artifacts[0].expiresAt = new Date(now.getTime() + 7 * 24 * HOUR);
        }
      };

      await expect(service.runSweep(now)).resolves.toMatchObject({ artifactsWithoutDirectory: 0 });

      expect(artifactDeletes).toBe(2);
      expect(tables.artifacts.map(({ sha256 }) => sha256)).toEqual([sha('a')]);
      expect(await exists(join(root, 'demo-sink', sha('a')))).toBe(true);
    });

    it('is left alone when its slug is no path segment, for the resolver to refuse (#1094)', async () => {
      tables.artifacts.push(artifactRow(sha('a'), new Date(now.getTime() + HOUR), '../escape'));

      await expect(service.runSweep(now)).resolves.toMatchObject({ artifactsWithoutDirectory: 0 });

      expect(tables.artifacts).toHaveLength(1);
    });
  });

  it('stops honouring a load record five minutes after its last heartbeat, not a millisecond sooner (#1094)', async () => {
    tables.loads.push(
      loadRow(sha('a'), ago(PLUGIN_LOAD_STALE_MS), 'process-1'),
      loadRow(sha('b'), ago(PLUGIN_LOAD_STALE_MS - 1), 'process-2'),
    );
    const stale = await artifactDirectory('demo-sink', sha('a'), AGED);
    const fresh = await artifactDirectory('demo-sink', sha('b'), AGED);

    await expect(service.runSweep(now)).resolves.toMatchObject({ staleLoadRecords: 1, removedDirectories: 1 });

    expect(tables.loads.map(({ processId }) => processId)).toEqual(['process-2']);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('leaves lost+found and other strangers alone, logging only the strangers as warnings (#1094)', async () => {
    const strangers: Record<string, string> = {
      'notes.txt': join(root, 'notes.txt'),
      Not_A_Slug: join(root, 'Not_A_Slug'),
      'demo-sink/README.md': join(root, 'demo-sink', 'README.md'),
      [`demo-sink/${sha('b')}`]: join(root, 'demo-sink', sha('b')),
      'demo-sink/backup': join(root, 'demo-sink', 'backup'),
    };
    // The filesystem's own, at the root of an ext4 volume.
    const lostAndFound = join(root, 'lost+found');
    await mkdir(lostAndFound);
    await writeFile(join(lostAndFound, '#1234'), 'recovered');
    await writeFile(join(root, 'notes.txt'), 'notes');
    // Checksum-shaped inside, but its own name is no slug.
    await mkdir(join(root, 'Not_A_Slug', sha('a')), { recursive: true });
    await mkdir(join(root, 'demo-sink'));
    await writeFile(join(root, 'demo-sink', 'README.md'), 'readme');
    // Named like a checksum, but a file.
    await writeFile(join(root, 'demo-sink', sha('b')), 'not a directory');
    await mkdir(join(root, 'demo-sink', 'backup'));
    await age(join(root, 'Not_A_Slug', sha('a')), AGED);
    // The slug directory too: aged, and holding only strangers, it stays whole.
    for (const path of [lostAndFound, ...Object.values(strangers), join(root, 'demo-sink')]) {
      await age(path, AGED);
    }
    const unnamed = await artifactDirectory('other-plugin', sha('c'), AGED);

    await service.runSweep(now);

    for (const path of [lostAndFound, ...Object.values(strangers)]) {
      expect(await exists(path)).toBe(true);
    }
    expect(await exists(join(root, 'Not_A_Slug', sha('a')))).toBe(true);
    expect(await exists(unnamed)).toBe(false);
    for (const relative of Object.keys(strangers)) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${relative} `));
    }
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('lost+found '));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('lost+found'));
  });

  it('leaves symbolic links alone, and never follows one out of the root (#1094)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'bge-sweep-outside-'));

    try {
      const target = join(outside, sha('a'));
      await mkdir(target);
      await writeFile(join(target, 'manifest.json'), '{}');
      await age(target, AGED);
      // A slug that is a link out of the root, and a checksum entry that is a
      // link to an aged directory outside it.
      await symlink(outside, join(root, 'linked-plugin'));
      await mkdir(join(root, 'demo-sink'));
      await symlink(target, join(root, 'demo-sink', sha('b')));

      await service.runSweep(now);

      expect(await exists(join(target, 'manifest.json'))).toBe(true);
      expect(await exists(join(root, 'linked-plugin'))).toBe(true);
      expect(await exists(join(root, 'demo-sink', sha('b')))).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('linked-plugin '));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`demo-sink/${sha('b')} `));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('walks a plugins root that is itself a symbolic link (#1094)', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'bge-sweep-link-'));

    try {
      const linkedRoot = join(parent, 'plugins');
      await symlink(root, linkedRoot);
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);

      await expect(sweepWith(linkedRoot).runSweep(now)).resolves.toMatchObject({ removedDirectories: 1 });

      expect(await exists(dir)).toBe(false);
      expect(await exists(linkedRoot)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  // The sweep looks only at <slug>/<sha256> and .incoming/*, so a slug
  // directory stays whatever it holds: empty, it is harmless clutter.
  describe('slug directories (#1094)', () => {
    it('leaves an empty slug directory alone, whatever its age (#1094)', async () => {
      await mkdir(join(root, 'aged-plugin'));
      await age(join(root, 'aged-plugin'), AGED);

      await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 0 });

      expect(await exists(join(root, 'aged-plugin'))).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps a slug directory whose last artifact it removed, on every later run (#1094)', async () => {
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
      await age(join(root, 'demo-sink'), AGED);

      await service.runSweep(now);

      expect(await exists(dir)).toBe(false);
      expect(await exists(join(root, 'demo-sink'))).toBe(true);

      // An hour on, it has aged with nothing in it.
      await age(join(root, 'demo-sink'), AGED);
      await service.runSweep(now);

      expect(await exists(join(root, 'demo-sink'))).toBe(true);
    });
  });

  it('removes .incoming entries older than the grace period and keeps the rest (#1094)', async () => {
    const incoming = join(root, INCOMING_DIRNAME);
    await mkdir(incoming);
    const scratchArchive = async (name: string, ageMs: number) => {
      const path = join(incoming, name);
      await writeFile(path, 'gzip bytes');
      await age(path, ageMs);
      return path;
    };
    const scratchExtraction = async (name: string, ageMs: number) => {
      const path = join(incoming, name);
      await mkdir(join(path, 'package'), { recursive: true });
      await writeFile(join(path, 'package', 'manifest.json'), '{}');
      await age(path, ageMs);
      return path;
    };
    const removed = [
      await scratchArchive('aged.tgz', AGED),
      await scratchExtraction('aged', AGED),
      await scratchArchive('at-grace.tgz', PLUGIN_ARTIFACT_SWEEP_GRACE_MS),
    ];
    const kept = [
      await scratchArchive('younger.tgz', PLUGIN_ARTIFACT_SWEEP_GRACE_MS - 1000),
      await scratchExtraction('young', YOUNG),
    ];
    await age(incoming, AGED);

    await expect(service.runSweep(now)).resolves.toMatchObject({ removedIncoming: 3, removedDirectories: 0 });

    for (const path of removed) {
      expect(await exists(path)).toBe(false);
    }
    for (const path of kept) {
      expect(await exists(path)).toBe(true);
    }
    // The directory itself stays, for the next upload.
    expect(await exists(incoming)).toBe(true);
  });

  describe('removing an artifact directory', () => {
    it('moves it aside first, so its checksum path is gone the moment the rename lands (#1094)', async () => {
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
      const seen: { aside: string; checksumPathThere: boolean; asideComplete: boolean }[] = [];
      jest.mocked(rm).mockImplementation(async (path, options) => {
        if (String(path).endsWith('.swept')) {
          seen.push({
            aside: String(path),
            checksumPathThere: await exists(dir),
            asideComplete: await exists(join(String(path), 'manifest.json')),
          });
        }
        return actualRm(path, options);
      });

      await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 1 });

      // By the time the removal starts, the whole tree has left the checksum
      // path for one place in .incoming/, on the same filesystem.
      expect(seen).toEqual([{ aside: expect.any(String), checksumPathThere: false, asideComplete: true }]);
      expect(dirname(seen[0].aside)).toBe(join(root, INCOMING_DIRNAME));
      expect(await exists(seen[0].aside)).toBe(false);
      expect(await incomingEntries()).toEqual([]);
    });

    it('a removal that fails partway leaves the checksum path absent, and the next run clears the copy (#1094)', async () => {
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
      jest.mocked(rm).mockImplementation(async (path, options) => {
        if (String(path).endsWith('.swept')) {
          throw Object.assign(new Error(`EACCES: permission denied, rm '${String(path)}'`), { code: 'EACCES' });
        }
        return actualRm(path, options);
      });

      await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 1 });

      expect(await exists(dir)).toBe(false);
      const [leftover] = await incomingEntries();
      expect(leftover).toMatch(/\.swept$/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${INCOMING_DIRNAME}/${leftover} `));

      jest.mocked(rm).mockImplementation(actualRm);
      await expect(service.runSweep(now)).resolves.toMatchObject({ removedIncoming: 1 });

      expect(await incomingEntries()).toEqual([]);
    });

    it('clears a copy a removal left in .incoming whatever its age (#1094)', async () => {
      const leftover = join(root, INCOMING_DIRNAME, 'tz4a98xxat96iws9zmbrgj3a.swept');
      await mkdir(join(leftover, 'node_modules'), { recursive: true });
      await age(leftover, YOUNG);

      await expect(service.runSweep(now)).resolves.toMatchObject({ removedIncoming: 1 });

      expect(await exists(leftover)).toBe(false);
    });

    it('moves nothing through a .incoming that is a symbolic link (#1094)', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'bge-sweep-outside-'));

      try {
        await symlink(outside, join(root, INCOMING_DIRNAME));
        const dir = await artifactDirectory('demo-sink', sha('a'), AGED);

        await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 0 });

        expect(await exists(dir)).toBe(true);
        expect(await actualReaddir(outside)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`demo-sink/${sha('a')} `));
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('logs a directory it cannot move, and goes on with the rest (#1094)', async () => {
      const stuck = await artifactDirectory('demo-sink', sha('a'), AGED);
      const other = await artifactDirectory('other-plugin', sha('b'), AGED);
      jest.mocked(rename).mockImplementation(async (from, to) => {
        if (from === stuck) {
          throw Object.assign(new Error(`EACCES: permission denied, rename '${stuck}'`), { code: 'EACCES' });
        }
        return actualRename(from, to);
      });

      await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 1 });

      expect(await exists(stuck)).toBe(true);
      expect(await exists(other)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`demo-sink/${sha('a')} `));
    });
  });

  describe('a database that holds no plugin at all', () => {
    beforeEach(() => {
      // As a mistyped DATABASE_URL gives: the api migrates and seeds an empty database at boot.
      tables.plugins.splice(0);
    });

    it('spares every artifact directory, says why once, and sweeps the rest as usual (#1094)', async () => {
      const spared = [
        await artifactDirectory('demo-sink', sha('a'), AGED),
        await artifactDirectory('other-plugin', sha('b'), AGED),
      ];
      await mkdir(join(root, INCOMING_DIRNAME));
      await writeFile(join(root, INCOMING_DIRNAME, 'stale.tgz'), 'gzip bytes');
      await age(join(root, INCOMING_DIRNAME, 'stale.tgz'), AGED);
      await mkdir(join(root, 'empty-plugin'));
      await age(join(root, 'empty-plugin'), AGED);
      await writeFile(join(root, 'notes.txt'), 'notes');

      await expect(service.runSweep(now)).resolves.toEqual({
        removedDirectories: 0,
        removedIncoming: 1,
        expiredArtifacts: 0,
        artifactsWithoutDirectory: 0,
        staleLoadRecords: 0,
      });

      for (const dir of spared) {
        expect(await exists(dir)).toBe(true);
      }
      expect(await exists(join(root, 'empty-plugin'))).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('notes.txt '));
      const guardWarnings = warn.mock.calls.filter(([message]) => String(message).includes('DATABASE_URL'));
      expect(guardWarnings).toEqual([[expect.stringContaining('2 plugin artifact directories')]]);
      expect(guardWarnings[0][0]).toContain('no plugin at all');
      // A server that has only ever received plugin artifacts reads the same.
      expect(guardWarnings[0][0]).toContain('received and never installed');
    });

    it('does not warn when it had nothing aged to spare (#1094)', async () => {
      tables.artifacts.push(artifactRow(sha('a'), new Date(now.getTime() + HOUR)));
      await artifactDirectory('demo-sink', sha('a'), AGED);
      await artifactDirectory('demo-sink', sha('b'), YOUNG);

      await service.runSweep(now);

      expect(warn).not.toHaveBeenCalled();
    });

    it('sweeps as usual once the database holds a single plugin row, an uninstalled one included (#1094)', async () => {
      tables.plugins.push(pluginRow({ slug: 'unrelated', installedSha256: sha('9'), uninstalledAt: ago(AGED) }));
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);

      await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 1 });

      expect(await exists(dir)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('two sweeps at once do no harm (#1094)', async () => {
    tables.plugins.push(pluginRow({ installedSha256: sha('1') }));
    const installed = await artifactDirectory('demo-sink', sha('1'), AGED);
    const unnamed = await artifactDirectory('other-plugin', sha('2'), AGED);
    await mkdir(join(root, INCOMING_DIRNAME));
    await writeFile(join(root, INCOMING_DIRNAME, 'stale.tgz'), 'gzip bytes');
    await age(join(root, INCOMING_DIRNAME, 'stale.tgz'), AGED);

    const results = await Promise.all([service.runSweep(now), service.runSweep(now)]);

    expect(await exists(unnamed)).toBe(false);
    expect(await exists(join(root, INCOMING_DIRNAME, 'stale.tgz'))).toBe(false);
    expect(await exists(installed)).toBe(true);
    // Each run may count a removal both reached; what matters is that it happened.
    expect(results.some(({ removedDirectories }) => removedDirectories === 1)).toBe(true);
    expect(results.every(({ removedDirectories }) => removedDirectories <= 1)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('skips quietly what another sweep removed after this one listed it (#1094)', async () => {
    const slugGone = await artifactDirectory('other-plugin', sha('b'), AGED);
    const directoryGone = await artifactDirectory('demo-sink', sha('a'), AGED);
    // The other sweep gets in between each listing and the visits that follow it.
    jest.mocked(readdir).mockImplementation((async (path: string) => {
      const names = await actualReaddir(path);
      if (path === root) {
        await actualRm(join(root, 'other-plugin'), { recursive: true, force: true });
      }
      if (path === join(root, 'demo-sink')) {
        await actualRm(directoryGone, { recursive: true, force: true });
      }
      return names;
    }) as never);

    await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 0 });

    expect(await exists(slugGone)).toBe(false);
    // The other sweep emptied it, and an empty slug directory stays.
    expect(await exists(join(root, 'demo-sink'))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("an uninstalled plugin's directory goes once no process has it loaded (#1094)", async () => {
    tables.plugins.push(pluginRow({ installedSha256: sha('a'), uninstalledAt: ago(HOUR) }));
    tables.loads.push(loadRow(sha('a'), ago(MINUTE)));
    const dir = await artifactDirectory('demo-sink', sha('a'), AGED);

    await service.runSweep(now);

    expect(await exists(dir)).toBe(true);

    // The process that ran it shuts down cleanly and deletes its record.
    tables.loads.splice(0);
    await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 1, staleLoadRecords: 0 });

    expect(await exists(dir)).toBe(false);
  });

  it('a plugins root that does not exist yet has nothing to sweep (#1094)', async () => {
    tables.artifacts.push(artifactRow(sha('a'), now));

    await expect(sweepWith(join(root, 'not-created')).runSweep(now)).resolves.toEqual({
      removedDirectories: 0,
      removedIncoming: 0,
      expiredArtifacts: 1,
      artifactsWithoutDirectory: 0,
      staleLoadRecords: 0,
    });

    expect(await exists(join(root, 'not-created'))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('at shutdown', () => {
    it('waits for the run in flight, which walks no further once shutdown begins (#1094)', async () => {
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
      const release = holdFirstDelete();
      const run = service.runSweep(now);
      let shutDown = false;
      const shutdown = service.beforeApplicationShutdown().then(() => {
        shutDown = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(shutDown).toBe(false);

      release();
      // The run finishes its queries, on a pool shutdown has not ended yet, and stops before the walk.
      await expect(run).resolves.toMatchObject({ removedDirectories: 0 });
      await shutdown;

      expect(shutDown).toBe(true);
      expect(await exists(dir)).toBe(true);
      expect(error).not.toHaveBeenCalled();
    });

    it('stops at the next entry when shutdown begins mid-walk (#1094)', async () => {
      const first = await artifactDirectory('demo-sink', sha('a'), AGED);
      const second = await artifactDirectory('other-plugin', sha('b'), AGED);
      let shutdown: Promise<void> | undefined;
      jest.mocked(rename).mockImplementationOnce(async (from, to) => {
        shutdown = service.beforeApplicationShutdown();
        return actualRename(from, to);
      });

      await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 1 });
      await shutdown;

      // Whichever came first went; the walk stopped before the other.
      expect([await exists(first), await exists(second)].filter(Boolean)).toHaveLength(1);
    });

    it('stops waiting for a stuck run after five seconds, says so, and lets shutdown go on (#1094)', async () => {
      // Only the timer is faked: the filesystem and the promises run as usual.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'Date'] });

      try {
        // A query that never answers.
        const release = holdFirstDelete();
        let runSettled = false;
        const run = service.runSweep(now).finally(() => {
          runSettled = true;
        });
        let shutDown = false;
        const shutdown = service.beforeApplicationShutdown().then(() => {
          shutDown = true;
        });

        await jest.advanceTimersByTimeAsync(PLUGIN_ARTIFACT_SWEEP_SHUTDOWN_WAIT_MS - 1);

        expect(shutDown).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        await shutdown;

        expect(runSettled).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopped waiting for the plugin artifact sweep'));

        // Let the abandoned run end, so nothing outlives the test.
        release();
        await run;
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves a copy it moved aside once shutdown has begun for the next run to clear (#1094)', async () => {
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
      let shutdown: Promise<void> | undefined;
      jest.mocked(rename).mockImplementationOnce(async (from, to) => {
        await actualRename(from, to);
        // Shutdown begins the moment the directory lands in .incoming/.
        shutdown = service.beforeApplicationShutdown();
      });

      await expect(service.runSweep(now)).resolves.toMatchObject({ removedDirectories: 1 });
      await shutdown;

      expect(await exists(dir)).toBe(false);
      const [leftover] = await incomingEntries();
      expect(leftover).toMatch(/\.swept$/);
      expect(rm).not.toHaveBeenCalledWith(expect.stringContaining('.swept'), expect.anything());

      // The next process's sweep clears it.
      await expect(sweepWith(root).runSweep(now)).resolves.toMatchObject({ removedIncoming: 1 });

      expect(await incomingEntries()).toEqual([]);
    });

    it('turns away a run that starts once shutdown has begun (#1094)', async () => {
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
      await service.beforeApplicationShutdown();

      await expect(service.runSweep(now)).resolves.toEqual({
        removedDirectories: 0,
        removedIncoming: 0,
        expiredArtifacts: 0,
        artifactsWithoutDirectory: 0,
        staleLoadRecords: 0,
      });

      expect(db.pluginArtifact.deleteMany).not.toHaveBeenCalled();
      expect(await exists(dir)).toBe(true);
    });
  });

  describe('boot and hourly runs', () => {
    it('the boot run sweeps in a system actor scope named for it, and boot does not wait for it (#1094)', async () => {
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
      const release = holdFirstDelete();

      expect(service.onApplicationBootstrap()).toBeUndefined();

      // Boot has its answer while the run still waits on the database.
      expect(scope.run).toHaveBeenCalledWith('plugin-artifact-sweep', expect.any(Function));
      expect(await exists(dir)).toBe(true);

      release();
      await settle();

      expect(await exists(dir)).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    });

    it('a boot run whose database read fails logs it, removes nothing and never throws into Nest (#1094)', async () => {
      const dir = await artifactDirectory('demo-sink', sha('a'), AGED);
      db.plugin.findMany.mockRejectedValueOnce(new Error('connection refused'));

      expect(() => service.onApplicationBootstrap()).not.toThrow();
      await settle();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
      // Without the full set of what to keep, nothing is removed.
      expect(await exists(dir)).toBe(true);
    });

    it('the hourly run sweeps in the same scope, and logs a failure instead of throwing it (#1094)', async () => {
      db.pluginArtifact.deleteMany.mockRejectedValueOnce(new Error('deadlock detected'));

      await expect(service.sweepOnInterval()).resolves.toBeUndefined();

      expect(scope.run).toHaveBeenCalledWith('plugin-artifact-sweep', expect.any(Function));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('deadlock detected'));
    });
  });
});
