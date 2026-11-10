import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import type { PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createId } from '@paralleldrive/cuid2';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';

/** How often a process refreshes the heartbeat of its load records (#1094). */
export const PLUGIN_LOAD_HEARTBEAT_MS = 60_000;

/**
 * A load record whose heartbeat is older than this no longer protects its
 * artifact directory from the sweep (#1094): the process that wrote it died
 * without cleaning up. Five missed heartbeats, so a slow database or a
 * paused process does not unprotect code it still runs.
 */
export const PLUGIN_LOAD_STALE_MS = 5 * 60_000;

/** A plugin artifact this process recorded loading, and when. */
interface LoadRecord {
  readonly sha256: PluginArtifactSha256;
  readonly loadedAt: Date;
}

/**
 * Records, per process, which plugin artifact each loaded plugin runs
 * (#1094), so the artifact sweep never removes code a running process still
 * uses. One `PluginProcessLoad` row per (process, plugin): written before the
 * loader reads the plugin's directory, refreshed every minute, deleted at a
 * clean shutdown.
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

  constructor(
    private readonly db: DatabaseService,
    private readonly systemActorScope: SystemActorScope,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * An upsert, so a restarted plugin's record and a reload both land on the
   * one (process, slug) row. The record is held in memory before it is
   * written, so a failed write is repaired by the next heartbeat. A failure
   * still rejects, so the loader can log it.
   */
  async record(slug: string, sha256: PluginArtifactSha256): Promise<void> {
    const load: LoadRecord = { sha256, loadedAt: new Date() };
    this.loads.set(slug, load);

    await this.write(slug, load, load.loadedAt);
  }

  /**
   * Refreshes this process's rows with one `updateMany`. When it touches
   * fewer rows than the process recorded, some are missing, and every
   * record is written again with its original load time. Swallows its own
   * errors so a tick cannot crash the scheduler; the next tick tries again.
   * Requires `ScheduleModule.forRoot()` in the host.
   */
  @Interval('plugin-load-heartbeat', PLUGIN_LOAD_HEARTBEAT_MS)
  async heartbeat(): Promise<void> {
    try {
      await this.systemActorScope.run('plugin-load-heartbeat', async () => {
        const now = new Date();
        const { count } = await this.db.pluginProcessLoad.updateMany({
          where: { processId: this.processId },
          data: { heartbeatAt: now },
        });

        if (count >= this.loads.size) {
          return;
        }

        for (const [slug, load] of this.loads) {
          await this.write(slug, load, now);
        }
      });
    } catch (err) {
      this.logger.error(`Plugin load heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `apps/api/src/main.ts` handles its own signals and calls `app.close()`,
   * and `app.close()` is what runs this hook; no `enableShutdownHooks()` is
   * needed. A failed delete is logged, not thrown, so the other shutdown
   * hooks still run: the rows then go stale and the sweep stops honouring
   * them after `PLUGIN_LOAD_STALE_MS`. The records in memory are dropped
   * first, so a heartbeat that ticks before the scheduler stops writes none
   * of them again; one already writing may still land, and that row goes
   * stale the same way.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.loads.clear();

    try {
      await this.systemActorScope.run('plugin-load-shutdown', () =>
        this.db.pluginProcessLoad.deleteMany({ where: { processId: this.processId } }),
      );
    } catch (err) {
      this.logger.error(`Failed to delete plugin load records: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async write(slug: string, { sha256, loadedAt }: LoadRecord, heartbeatAt: Date): Promise<void> {
    const processRole = this.options.processRole;

    await this.db.pluginProcessLoad.upsert({
      where: { processId_slug: { processId: this.processId, slug } },
      create: { processId: this.processId, processRole, slug, sha256, loadedAt, heartbeatAt },
      update: { processRole, sha256, loadedAt, heartbeatAt },
    });
  }
}
