import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService, PLUGIN_LOAD_STALE_MS } from '@bge/database';
import type { PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createId } from '@paralleldrive/cuid2';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';

/** How often a process refreshes the heartbeat of its load records (#1094). */
export const PLUGIN_LOAD_HEARTBEAT_MS = 60_000;

/**
 * How long shutdown waits for a write in flight before it deletes this
 * process's load records anyway (#1083). The api's shutdown has no deadline
 * of its own, so a write that never settles would otherwise hold up every
 * other shutdown hook. The same wait the artifact sweep gives its run.
 */
export const PLUGIN_LOAD_SHUTDOWN_WAIT_MS = 5_000;

/** A plugin artifact this process recorded loading, which install it is, when, and whether the load completed. */
interface LoadRecord {
  readonly sha256: PluginArtifactSha256;

  /** The plugin row's `installedAt` the loader read (#1083). */
  readonly installedAt: Date;

  /** Whether the plugin's product is registered in this process (#1083). */
  readonly ready: boolean;

  readonly loadedAt: Date;
}

/**
 * Records, per process, which plugin artifact each loaded plugin runs
 * (#1094), so the artifact sweep never removes code a running process still
 * uses. One `PluginProcessLoad` row per (process, plugin): written before the
 * loader reads the plugin's directory, marked ready once the plugin's product
 * is registered, refreshed every minute, deleted at a clean shutdown. The
 * install marker and readiness are what a process that doesn't load the
 * plugin reads to learn whether one that does has it loaded (#1083).
 *
 * A process whose `app.close()` stops serving before the shutdown hooks run
 * calls `withdrawLoadRecords()` itself, ahead of `app.close()`. The
 * coordinator does: Nest closes a microservice's gRPC server first, and for
 * as long as the hooks then take, a gateway worker reading a ready record
 * would dial a server that is gone and count each failure against the plugin
 * DataGateway (#1083).
 *
 * The recorder also holds every record in memory, and the heartbeat writes a
 * missing one again. A row can go missing while the process still runs its
 * code: its first write failed, or the database was out of reach for five
 * minutes and a sweep deleted the row as stale. Without the rewrite, an
 * update or an uninstall would leave that code's directory unprotected until
 * the process restarts.
 *
 * Its work happens at boot, on a timer and at shutdown, outside any request,
 * so it reaches `DatabaseService` directly and runs the timer and shutdown
 * writes in a system actor scope, as the boot load does; the scope opens its
 * own CLS context, so it works inside an `@Interval` callback and a shutdown
 * hook. `record()` runs inside the loader's `plugin-boot-load` scope.
 */
@Injectable()
export class PluginLoadRecorder implements BeforeApplicationShutdown {
  private readonly logger = new Logger(PluginLoadRecorder.name);

  /** Names this process in every row it writes; new on each start. */
  readonly processId: string = createId();

  /** What this process recorded, by slug: the rows the heartbeat keeps in place. */
  private readonly loads = new Map<string, LoadRecord>();

  /**
   * Set when a row may hold a value older than the record in memory: a
   * write of it failed, or `record()` or `markReady()` wrote it while a
   * heartbeat rewrite was under way, whose write of the older record can
   * land after theirs. The row still exists and refreshes, so the count of
   * refreshed rows can't show it. Cleared as the heartbeat starts writing
   * every record again.
   */
  private rewritePending = false;

  /** True while the heartbeat writes every record again; only one rewrite runs at a time. */
  private rewriting = false;

  /** Set once shutdown begins: nothing is recorded, marked or refreshed after it. */
  private stopping = false;

  /** The ticks and writes in flight, which shutdown waits for before it deletes the rows. */
  private readonly inFlight = new Set<Promise<unknown>>();

  /** The withdrawal once begun, so a second call waits for it instead of deleting again. */
  private withdrawal?: Promise<void>;

  constructor(
    private readonly db: DatabaseService,
    private readonly systemActorScope: SystemActorScope,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * An upsert, so a restarted plugin's record and a reload both land on the
   * one (process, slug) row. Not ready: the load has only begun. The record
   * is held in memory before it is written, so a failed write is repaired by
   * the next heartbeat. A failure still rejects, so the loader can log it.
   * Once shutdown has begun it records nothing.
   */
  async record(slug: string, sha256: PluginArtifactSha256, installedAt: Date): Promise<void> {
    if (this.stopping) {
      return;
    }

    const load: LoadRecord = { sha256, installedAt, ready: false, loadedAt: new Date() };
    this.loads.set(slug, load);
    this.flagIfRewriting();

    await this.writeNow(slug, load, load.loadedAt);
  }

  /**
   * Marks a recorded load ready once the plugin's product is registered
   * (#1083): from then on the row tells other processes this install is
   * loaded here. Held in memory first and repaired by the next heartbeat,
   * as `record()` is; a failure still rejects. A slug this process never
   * recorded has no row to mark, and once shutdown has begun none is marked.
   */
  async markReady(slug: string): Promise<void> {
    const recorded = this.loads.get(slug);

    if (this.stopping || recorded === undefined) {
      return;
    }

    const load: LoadRecord = { ...recorded, ready: true };
    this.loads.set(slug, load);
    this.flagIfRewriting();

    await this.writeNow(slug, load, new Date());
  }

  /**
   * Refreshes this process's rows with one `updateMany`. When it touches
   * fewer rows than the process recorded, some are missing; when that
   * happens, or a row may hold an older value than memory (see
   * `rewritePending`), every record is written again with its original load
   * time. Swallows its own errors so a tick cannot crash the scheduler; the
   * next tick tries again.
   *
   * `@Interval` does not wait for a tick to finish, and every tick sends the
   * refresh whatever earlier ticks are doing: a write that never settles
   * must not stop the refresh, or the rows go stale while this process still
   * runs their code. Only the rewrite runs one at a time: two at once would
   * let the first to finish clear `rewriting` while the other still writes
   * older records. A tick that needs a rewrite while one runs leaves the
   * need pending for a later tick and warns, so a stuck rewrite shows. Nothing
   * runs once shutdown has begun. Requires `ScheduleModule.forRoot()` in the
   * host.
   */
  @Interval('plugin-load-heartbeat', PLUGIN_LOAD_HEARTBEAT_MS)
  async heartbeat(): Promise<void> {
    if (this.stopping) {
      return;
    }

    await this.track(this.tick());
  }

  private async tick(): Promise<void> {
    try {
      await this.systemActorScope.run('plugin-load-heartbeat', async () => {
        const now = new Date();
        const { count } = await this.db.pluginProcessLoad.updateMany({
          where: { processId: this.processId },
          data: { heartbeatAt: now },
        });

        if (count >= this.loads.size && !this.rewritePending) {
          return;
        }

        // Kept pending, whether it came from the count or the flag, so the
        // first tick after the running rewrite ends does it.
        if (this.rewriting) {
          this.rewritePending = true;
          this.logger.warn(
            'A plugin load record rewrite is still under way from an earlier heartbeat; ' +
              'the rewrite this one needs waits for a later heartbeat.',
          );
          return;
        }

        // Cleared before the writes, so a write that fails during them, or
        // a `record()` or `markReady()` that lands among them, leaves it set
        // for the next tick.
        this.rewritePending = false;
        this.rewriting = true;

        try {
          // Each record is read from memory as the loop reaches it, so one
          // marked ready before then is written ready.
          for (const [slug, load] of this.loads) {
            await this.writeNow(slug, load, now);
          }
        } finally {
          this.rewriting = false;
        }
      });
    } catch (err) {
      this.logger.error(`Plugin load heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `app.close()` runs this hook; `apps/api/src/main.ts` handles its own
   * signals and calls it, and no `enableShutdownHooks()` is needed. The api
   * relies on the hook alone: its HTTP server closes after the hooks run. A
   * process that called `withdrawLoadRecords()` before `app.close()` has
   * nothing left to do here, and this waits for that withdrawal.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.withdrawLoadRecords();
  }

  /**
   * Withdraws this process's plugin load records: what a clean shutdown
   * does, callable ahead of `app.close()` by a process that stops serving
   * before its shutdown hooks run (see the class comment). Safe to call more
   * than once: every call after the first waits for the first, and nothing
   * is deleted twice.
   *
   * A row left behind misleads twice: the sweep keeps its artifact
   * directory, and a process that reads the rows (the gateway worker routing
   * to the coordinator, the api deciding a cold enable, #1083) takes this
   * plugin as loaded by a process that has stopped, for up to
   * `PLUGIN_LOAD_STALE_MS`, with no process left to correct it. So this
   * first stops everything that writes (`record`, `markReady` and the
   * heartbeat do nothing from here on, and the records in memory are
   * dropped), then waits for the tick and writes already in flight, and only
   * then deletes, so no write lands after the delete.
   *
   * The wait is bounded by `PLUGIN_LOAD_SHUTDOWN_WAIT_MS`, so a write that
   * never settles cannot hold up the other shutdown hooks; that write may
   * still land after the delete, and its row goes stale as above. A failed
   * delete is logged, not thrown, for the same reason, and its rows go stale
   * the same way. The database pool ends in `onApplicationShutdown`, after
   * this resolves, so the writes waited for finish on a live pool.
   */
  withdrawLoadRecords(): Promise<void> {
    this.withdrawal ??= this.withdraw();

    return this.withdrawal;
  }

  private async withdraw(): Promise<void> {
    this.stopping = true;
    this.loads.clear();
    await this.settleInFlight();

    try {
      await this.systemActorScope.run('plugin-load-shutdown', () =>
        this.db.pluginProcessLoad.deleteMany({ where: { processId: this.processId } }),
      );
    } catch (err) {
      this.logger.error(`Failed to delete plugin load records: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Waits for the ticks and writes in flight, for up to
   * `PLUGIN_LOAD_SHUTDOWN_WAIT_MS`. The timer is unreferenced, so it never
   * keeps the process alive by itself.
   */
  private async settleInFlight(): Promise<void> {
    if (this.inFlight.size === 0) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'abandoned'>((resolve) => {
      timer = setTimeout(() => resolve('abandoned'), PLUGIN_LOAD_SHUTDOWN_WAIT_MS);
      timer.unref();
    });

    try {
      const outcome = await Promise.race([Promise.allSettled(this.inFlight).then(() => 'settled' as const), deadline]);

      if (outcome === 'abandoned') {
        this.logger.warn(
          `Shutdown stopped waiting for a plugin load record write after ${PLUGIN_LOAD_SHUTDOWN_WAIT_MS / 1000} ` +
            'seconds. If it lands after the records are deleted, its row goes stale and is ignored after ' +
            `${PLUGIN_LOAD_STALE_MS / 60_000} minutes.`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Holds `work` in `inFlight` until it settles, so shutdown can wait for it. */
  private async track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);

    try {
      return await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  /**
   * A write that started while a rewrite was under way can be overtaken by
   * the rewrite's write of the older record, so the next heartbeat writes
   * every record again.
   */
  private flagIfRewriting(): void {
    if (this.rewriting) {
      this.rewritePending = true;
    }
  }

  /** Writes one record, and leaves a failure for the next heartbeat to repair. */
  private async writeNow(slug: string, load: LoadRecord, heartbeatAt: Date): Promise<void> {
    try {
      await this.track(this.write(slug, load, heartbeatAt));
    } catch (err) {
      this.rewritePending = true;
      throw err;
    }
  }

  private async write(
    slug: string,
    { sha256, installedAt, ready, loadedAt }: LoadRecord,
    heartbeatAt: Date,
  ): Promise<void> {
    const processRole = this.options.processRole;

    await this.db.pluginProcessLoad.upsert({
      where: { processId_slug: { processId: this.processId, slug } },
      create: { processId: this.processId, processRole, slug, sha256, installedAt, ready, loadedAt, heartbeatAt },
      update: { processRole, sha256, installedAt, ready, loadedAt, heartbeatAt },
    });
  }
}
