import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { MODULE_OPTIONS_TOKEN, PLUGIN_LOAD_STALE_MS, type PluginModuleOptions } from '@bge/plugin';
import { parsePluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createId } from '@paralleldrive/cuid2';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PluginArtifactStore } from '../store/plugin-artifact.store';
import { INCOMING_DIRNAME } from '../workspace/incoming';

/** The artifact sweep runs once at api boot, then every hour (#1094). */
export const PLUGIN_ARTIFACT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How old, by its own mtime, anything the sweep removes must be (#1094): a
 * directory nothing names, or scratch under `.incoming/`. It covers the
 * moments when nothing names a directory that is about to be needed: between
 * placement and the artifact row's commit, and after the sweep has read what
 * to keep. Placement touches a directory an identical post finds already
 * present, so that one is young as well.
 */
export const PLUGIN_ARTIFACT_SWEEP_GRACE_MS = 60 * 60 * 1000;

/**
 * How long shutdown waits for a run in flight before it goes on without it
 * (#1094). The api's shutdown has no deadline of its own, so a filesystem
 * call or a query that hangs would otherwise hold up every other shutdown
 * hook, the load recorder's included. Abandoning a run is safe: its
 * removals are atomic, and the next run clears what it left in
 * `.incoming/`.
 */
export const PLUGIN_ARTIFACT_SWEEP_SHUTDOWN_WAIT_MS = 5_000;

/** The hourly interval's name, and the reason its system actor records. */
const SWEEP_NAME = 'plugin-artifact-sweep';

/**
 * The name ending of a directory the sweep moved into `.incoming/` to remove
 * it there. Nothing else in `.incoming/` ends this way: a receipt names its
 * scratch by a bare id.
 */
const SWEPT_SUFFIX = '.swept';

/** The directory the filesystem keeps at the root of an ext4 volume, which the plugins root often is. */
const LOST_AND_FOUND = 'lost+found';

export interface PluginArtifactSweepResult {
  /** `<slug>/<sha256>/` directories removed. */
  readonly removedDirectories: number;
  /** Entries removed from `.incoming/`. */
  readonly removedIncoming: number;
  /** Artifact rows deleted at their expiry. */
  readonly expiredArtifacts: number;
  /** Live artifact rows deleted because their directory was gone, removed by hand. */
  readonly artifactsWithoutDirectory: number;
  /** Load records deleted because their process stopped refreshing them. */
  readonly staleLoadRecords: number;
}

/** What a run keeps, read once before its walk. */
interface WhatToKeep {
  /** The checksums something still needs. */
  readonly checksums: ReadonlySet<string>;
  /** Whether the database holds any plugin row at all, uninstalled ones included. */
  readonly anyPlugin: boolean;
}

interface WalkTotals {
  readonly removedDirectories: number;
  readonly removedIncoming: number;
  /** Aged directories nothing names, kept because the database holds no plugin at all. */
  readonly sparedDirectories: number;
}

const NOTHING_WALKED: WalkTotals = { removedDirectories: 0, removedIncoming: 0, sparedDirectories: 0 };

const addTotals = (totals: WalkTotals, more: Partial<WalkTotals> | undefined): WalkTotals => ({
  removedDirectories: totals.removedDirectories + (more?.removedDirectories ?? 0),
  removedIncoming: totals.removedIncoming + (more?.removedIncoming ?? 0),
  sparedDirectories: totals.sparedDirectories + (more?.sparedDirectories ?? 0),
});

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a directory entry the sweep leaves alone is, for the log. */
const describeEntry = (stats: Stats): string => {
  if (stats.isSymbolicLink()) {
    return 'a symbolic link';
  }
  if (stats.isFile()) {
    return 'a file';
  }
  return stats.isDirectory() ? 'a directory' : 'a special file';
};

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const summarize = (result: PluginArtifactSweepResult): string =>
  `Plugin artifact sweep removed ${counted(result.removedDirectories, 'artifact directory', 'artifact directories')} ` +
  `and ${counted(result.removedIncoming, 'incoming entry', 'incoming entries')}, ` +
  `and deleted ${counted(result.expiredArtifacts, 'expired artifact row', 'expired artifact rows')}, ` +
  `${counted(
    result.artifactsWithoutDirectory,
    'artifact row whose directory was gone',
    'artifact rows whose directory was gone',
  )} ` +
  `and ${counted(result.staleLoadRecords, 'stale load record', 'stale load records')}`;

/**
 * Removes what nothing needs from the plugins root (#1094): every
 * `<slug>/<sha256>/` plugin artifact directory that no living plugin row, no
 * unexpired artifact row and no fresh load record names, and scratch under
 * `.incoming/`, each once its own mtime is a grace period old. Anything else
 * in the root is logged and left alone, and a slug directory stays, empty or
 * not. An artifact row whose directory is gone can never install, so it is
 * deleted.
 *
 * It keeps the code a running process still uses: every process records the
 * checksum it loaded and refreshes the record every minute until it shuts
 * down. A record five minutes without a refresh is taken for a process that
 * died, and deleted. It never follows a symbolic link inside the root, so
 * nothing outside it is touched; removing a real directory recursively does
 * not follow the links inside it either.
 *
 * It runs at boot and every hour, in a system actor scope of its own. A run
 * that fails is logged and the next tries again. The boot run never holds up
 * or fails boot, and shutdown waits a few seconds at most for a run in
 * flight. Two runs at once, in one process or two, do no harm: each reads
 * what to keep before it walks, and a removal the other got to first is a
 * no-op. Requires `ScheduleModule.forRoot()` in the host for the hourly run,
 * which the api registers.
 */
@Injectable()
export class PluginArtifactSweepService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PluginArtifactSweepService.name);
  /** Set once shutdown begins: no run starts, and a run in flight walks no further entry. */
  private stopping = false;
  /** The runs in flight, which shutdown waits for. */
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly store: PluginArtifactStore,
    private readonly systemActorScope: SystemActorScope,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /** Starts the boot run and returns at once: boot does not wait for the walk, and the run logs its own result. */
  onApplicationBootstrap(): void {
    void this.sweepAndLog();
  }

  @Interval(SWEEP_NAME, PLUGIN_ARTIFACT_SWEEP_INTERVAL_MS)
  async sweepOnInterval(): Promise<void> {
    await this.sweepAndLog();
  }

  /**
   * Waits for the runs in flight, which stop before their next entry, for up
   * to `PLUGIN_ARTIFACT_SWEEP_SHUTDOWN_WAIT_MS`. The database pool ends in
   * `onApplicationShutdown`, which Nest runs only once this has resolved, so
   * a run's last queries finish on a live pool instead of failing into the
   * log. The timer is unreferenced, so it never keeps the process alive by
   * itself.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;

    if (this.running.size === 0) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'abandoned'>((resolve) => {
      timer = setTimeout(() => resolve('abandoned'), PLUGIN_ARTIFACT_SWEEP_SHUTDOWN_WAIT_MS);
      timer.unref();
    });

    try {
      const outcome = await Promise.race([Promise.allSettled(this.running).then(() => 'finished' as const), deadline]);

      if (outcome === 'abandoned') {
        this.logger.warn(
          `Shutdown stopped waiting for the plugin artifact sweep after ${PLUGIN_ARTIFACT_SWEEP_SHUTDOWN_WAIT_MS / 1000} ` +
            'seconds and left its run unfinished. Its removals are atomic, and the next run clears what it left behind.',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One run, with every comparison made against `now`. Public for tests, and
   * needs no actor scope. The boot and hourly runs open a system actor scope
   * named for the sweep, so anything that reads the actor during a run sees
   * which system task it is.
   */
  async runSweep(now: Date): Promise<PluginArtifactSweepResult> {
    const run = this.sweep(now);
    this.running.add(run);

    try {
      return await run;
    } finally {
      this.running.delete(run);
    }
  }

  private async sweep(now: Date): Promise<PluginArtifactSweepResult> {
    // Once shutdown has begun, a new run touches nothing: the pool is about to end.
    if (this.stopping) {
      return {
        removedDirectories: 0,
        removedIncoming: 0,
        expiredArtifacts: 0,
        artifactsWithoutDirectory: 0,
        staleLoadRecords: 0,
      };
    }

    const expiredArtifacts = await this.store.removeExpired(now);
    const artifactsWithoutDirectory = await this.removeArtifactRowsWithoutDirectory(now);
    const { count: staleLoadRecords } = await this.db.pluginProcessLoad.deleteMany({
      where: { heartbeatAt: { lte: new Date(now.getTime() - PLUGIN_LOAD_STALE_MS) } },
    });

    // Read once, before the walk: anything placed after this read is younger
    // than the grace period, so the walk leaves it.
    const keep = await this.readWhatToKeep();
    const walked = await this.walk(keep, now.getTime() - PLUGIN_ARTIFACT_SWEEP_GRACE_MS);

    if (walked.sparedDirectories > 0) {
      const spared = counted(walked.sparedDirectories, 'plugin artifact directory', 'plugin artifact directories');
      this.logger.warn(
        `The plugin artifact sweep kept ${spared} that nothing names, because the database holds no plugin at ` +
          'all, not even an uninstalled one. If plugins were installed on this server, check that DATABASE_URL ' +
          'points at its database. If none ever was, these are plugin artifacts that were received and never ' +
          'installed: they are removed after the first install, or can be deleted by hand from the plugins root.',
      );
    }

    const result: PluginArtifactSweepResult = {
      removedDirectories: walked.removedDirectories,
      removedIncoming: walked.removedIncoming,
      expiredArtifacts,
      artifactsWithoutDirectory,
      staleLoadRecords,
    };
    this.logger.log(summarize(result));

    return result;
  }

  /** A run in the sweep's own system actor scope. Its failure is logged, never thrown. */
  private async sweepAndLog(): Promise<void> {
    try {
      await this.systemActorScope.run(SWEEP_NAME, () => this.runSweep(new Date()));
    } catch (err) {
      this.logger.error(`The plugin artifact sweep failed; the next run tries again: ${describeError(err)}`);
    }
  }

  /**
   * Deletes every live artifact row whose `<slug>/<sha256>/` directory is gone,
   * and says how many (#1094). A row is written only once its directory is
   * placed, and the sweep never removes a directory a live row names, so a
   * missing one was removed by hand: the row can never install, and reading it
   * back answers not found. Deleted before what to keep is read, its checksum
   * keeps nothing. A row whose slug or checksum is not a path segment is left
   * for the directory resolver, which refuses it on use.
   *
   * Each delete names the expiry the row was read with. A re-post that placed
   * the directory again, or an install that refreshed the row, has moved it
   * since, and the row stays.
   */
  private async removeArtifactRowsWithoutDirectory(now: Date): Promise<number> {
    const live = await this.db.pluginArtifact.findMany({
      where: { expiresAt: { gt: now } },
      select: { sha256: true, slug: true, expiresAt: true },
    });
    let removed = 0;

    for (const { sha256, slug, expiresAt } of live) {
      if (this.stopping) {
        break;
      }

      if (!PLUGIN_SLUG_PATTERN.test(slug) || parsePluginArtifactSha256(sha256) === null) {
        continue;
      }

      if (!(await this.isGone(join(this.options.pluginsRoot, slug, sha256)))) {
        continue;
      }

      const { count } = await this.db.pluginArtifact.deleteMany({ where: { sha256, expiresAt } });
      if (count > 0) {
        removed += count;
        this.logger.debug(`Deleted the artifact row ${sha256}: its directory ${slug}/${sha256} is gone`);
      }
    }

    return removed;
  }

  /** Whether nothing is at `path`. Only `ENOENT` says so; on any other failure the row stays. */
  private async isGone(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return false;
    } catch (err) {
      return errorCode(err) === 'ENOENT';
    }
  }

  /**
   * Every checksum something still needs: a plugin row that is not
   * uninstalled names its installed artifact and any staged update, an
   * artifact row that has not expired names its own, and so does a fresh load
   * record.
   *
   * The three reads run one after another, in this order. Install commits the
   * plugin row and only then deletes the artifact row, so a checksum that has
   * left the artifact rows by the time they are read is already in the plugin
   * rows when those are read. Read the other way round, an install landing
   * between the two reads is in neither, and its directory, placed when the
   * artifact was received and so older than the grace period, would be
   * removed under a live plugin.
   *
   * Load records come last. They keep what a process still runs after an
   * approval or an uninstall has taken its checksum out of the plugin rows,
   * and a process records a checksum only after reading it from the plugin
   * row, so they are best read after the plugin rows.
   *
   * Every plugin row is read, uninstalled ones included, to tell whether
   * there is any at all (#1094). None is ever deleted: uninstalling a plugin
   * stamps its row and keeps it. So a database without a single plugin row
   * has never installed one, and that is also how a mistyped `DATABASE_URL`
   * looks, because the api migrates and seeds an empty database at boot
   * instead of failing. Against such a database every directory looks
   * unneeded, so the walk removes no artifact directory, and says so. The
   * cost falls on a server that receives plugin artifacts and never installs
   * one: it keeps their directories until its first install, and the warning
   * names that cause beside the mistyped `DATABASE_URL`.
   */
  private async readWhatToKeep(): Promise<WhatToKeep> {
    const artifacts = await this.db.pluginArtifact.findMany({ select: { sha256: true } });
    const plugins = await this.db.plugin.findMany({
      select: { installedSha256: true, pendingSha256: true, uninstalledAt: true },
    });
    const loads = await this.db.pluginProcessLoad.findMany({ select: { sha256: true } });

    const checksums = new Set<string>();
    for (const { sha256 } of artifacts) {
      checksums.add(sha256);
    }
    for (const { installedSha256, pendingSha256, uninstalledAt } of plugins) {
      // An uninstalled plugin's code is kept only while a process still runs it.
      if (uninstalledAt !== null) {
        continue;
      }

      checksums.add(installedSha256);
      if (pendingSha256 !== null) {
        checksums.add(pendingSha256);
      }
    }
    for (const { sha256 } of loads) {
      checksums.add(sha256);
    }

    return { checksums, anyPlugin: plugins.length > 0 };
  }

  /**
   * Walks the plugins root. The configured root may itself be a symbolic
   * link, as the directory resolver accepts, and listing it follows that one
   * link; every entry inside it is read with `lstat`, and only a real
   * directory is entered.
   */
  private async walk(keep: WhatToKeep, cutoffMs: number): Promise<WalkTotals> {
    const root = this.options.pluginsRoot;
    let totals = NOTHING_WALKED;

    for (const name of await this.entries(root)) {
      if (this.stopping) {
        break;
      }

      const swept = await this.guarded(name, async (): Promise<Partial<WalkTotals>> => {
        const path = join(root, name);
        const stats = await lstat(path);

        if (name === INCOMING_DIRNAME && stats.isDirectory()) {
          return { removedIncoming: await this.sweepIncoming(path, cutoffMs) };
        }

        if (PLUGIN_SLUG_PATTERN.test(name) && stats.isDirectory()) {
          return this.sweepSlugDirectory(name, path, keep, cutoffMs);
        }

        if (name === LOST_AND_FOUND && stats.isDirectory()) {
          this.logger.debug(`Left ${LOST_AND_FOUND} in the plugins root alone: the filesystem keeps it there`);
        } else {
          this.leaveAlone(name, stats);
        }

        return {};
      });

      totals = addTotals(totals, swept);
    }

    return totals;
  }

  /** Removes the artifact directories in one slug directory that nothing needs. The slug directory itself stays. */
  private async sweepSlugDirectory(
    slug: string,
    slugDir: string,
    keep: WhatToKeep,
    cutoffMs: number,
  ): Promise<Partial<WalkTotals>> {
    let removedDirectories = 0;
    let sparedDirectories = 0;

    for (const name of await this.entries(slugDir)) {
      if (this.stopping) {
        return { removedDirectories, sparedDirectories };
      }

      const relative = `${slug}/${name}`;

      const outcome = await this.guarded(relative, async (): Promise<'kept' | 'spared' | 'removed'> => {
        const path = join(slugDir, name);
        const stats = await lstat(path);
        const sha256 = parsePluginArtifactSha256(name);

        if (sha256 === null || !stats.isDirectory()) {
          this.leaveAlone(relative, stats);
          return 'kept';
        }

        if (keep.checksums.has(sha256) || stats.mtimeMs > cutoffMs) {
          return 'kept';
        }

        if (!keep.anyPlugin) {
          return 'spared';
        }

        await this.removeArtifactDirectory(relative, path);
        return 'removed';
      });

      if (outcome === 'removed') {
        removedDirectories += 1;
      } else if (outcome === 'spared') {
        sparedDirectories += 1;
      }
    }

    return { removedDirectories, sparedDirectories };
  }

  /**
   * Moves an artifact directory into `.incoming/` under a fresh name, then
   * removes it there.
   *
   * The decision to remove comes from an `lstat` just before this, and
   * placement touches an existing directory without a lock (#1094). A
   * re-post of the same expired artifact that lands between the two finds
   * the directory present, and then loses it: its post fails, or its row
   * names a directory that is gone, so reading or installing it answers not
   * found until it is posted again. Both steps are adjacent system calls and
   * the sweep runs hourly, so the race is left for a lock both sides take. The rename is one step, so the checksum path always
   * holds the complete directory or nothing. A crash, a shutdown or a failure
   * partway through the removal leaves a partial copy only in `.incoming/`,
   * for the next run to clear: never a partial directory that placement would
   * take for an artifact already present, nor one a new post adopts while it
   * is being deleted. Both paths are inside the plugins root, so the rename
   * never crosses a filesystem.
   */
  private async removeArtifactDirectory(relative: string, path: string): Promise<void> {
    const aside = join(await this.incomingDirectory(), `${createId()}${SWEPT_SUFFIX}`);

    await rename(path, aside);
    this.logger.debug(`Removed the plugin artifact directory ${relative}: nothing names it`);

    // A recursive removal can take a while, and shutdown should not wait on
    // one: once shutdown has begun, the copy is left for the next run.
    if (this.stopping) {
      this.logger.debug(`Left ${INCOMING_DIRNAME}/${basename(aside)} for the next run to clear: shutting down`);
      return;
    }

    try {
      await rm(aside, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(
        `The plugin artifact sweep could not finish removing ${INCOMING_DIRNAME}/${basename(aside)} ` +
          `(it was ${relative}), and the next run clears it: ${describeError(err)}`,
      );
    }
  }

  /**
   * `<root>/.incoming`, made if it is missing. Refused unless it is a real
   * directory: moving a directory through a link there could carry it out of
   * the root. A plain `mkdir`, which never follows a link, so a link there,
   * even one pointing nowhere, reaches the check below.
   */
  private async incomingDirectory(): Promise<string> {
    const dir = join(this.options.pluginsRoot, INCOMING_DIRNAME);

    try {
      await mkdir(dir);
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        throw err;
      }
    }

    const stats = await lstat(dir);
    if (!stats.isDirectory()) {
      throw new Error(
        `${INCOMING_DIRNAME} in the plugins root is ${describeEntry(stats)}, so no directory is moved into it`,
      );
    }

    return dir;
  }

  /** Removes `.incoming/` entries nothing needs: scratch a receipt that never finished left behind, once a grace period old. */
  private async sweepIncoming(incomingDir: string, cutoffMs: number): Promise<number> {
    let removed = 0;

    for (const name of await this.entries(incomingDir)) {
      if (this.stopping) {
        break;
      }

      const relative = `${INCOMING_DIRNAME}/${name}`;

      const gone = await this.guarded(relative, async () => {
        const path = join(incomingDir, name);

        // A directory a sweep moved aside is never needed again, so a copy a
        // failed or interrupted removal left goes whatever its age.
        if (!name.endsWith(SWEPT_SUFFIX) && (await lstat(path)).mtimeMs > cutoffMs) {
          return false;
        }

        // A link here is removed itself, never what it points to.
        await rm(path, { recursive: true, force: true });
        this.logger.debug(`Removed ${relative}: scratch nothing needs`);
        return true;
      });

      if (gone === true) {
        removed += 1;
      }
    }

    return removed;
  }

  /** The names in `dir`; none once it is gone, as after a concurrent sweep removed it, or before a root exists. */
  private async entries(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') {
        return [];
      }

      throw err;
    }
  }

  /**
   * Runs one entry's step. An entry that is gone meanwhile, as after a
   * concurrent sweep, is skipped quietly. Any other failure is logged and the
   * walk goes on, so one entry the sweep cannot handle never stops the rest.
   */
  private async guarded<T>(relative: string, step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        this.logger.warn(`The plugin artifact sweep could not handle ${relative} and left it: ${describeError(err)}`);
      }

      return undefined;
    }
  }

  /** An entry the sweep does not manage: logged on every run, never touched. */
  private leaveAlone(relative: string, stats: Stats): void {
    this.logger.warn(
      `The plugin artifact sweep left ${relative} alone: it is ${describeEntry(stats)}, not a plugin artifact directory`,
    );
  }
}
