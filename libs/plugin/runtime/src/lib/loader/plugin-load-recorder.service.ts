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

/**
 * Records, per process, which plugin artifact each loaded plugin runs
 * (#1094), so the artifact sweep never removes code a running process still
 * uses. One `PluginProcessLoad` row per (process, plugin): written when the
 * plugin registers, refreshed every minute, deleted at a clean shutdown.
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

  constructor(
    private readonly db: DatabaseService,
    private readonly systemActorScope: SystemActorScope,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * An upsert, so a restarted plugin's record and a reload both land on the
   * one (process, slug) row. A failure rejects: the loader decides what a
   * failed record costs (nothing, it retries once).
   */
  async record(slug: string, sha256: PluginArtifactSha256): Promise<void> {
    const now = new Date();

    await this.db.pluginProcessLoad.upsert({
      where: { processId_slug: { processId: this.processId, slug } },
      create: { processId: this.processId, processRole: this.options.processRole, slug, sha256 },
      update: { processRole: this.options.processRole, sha256, loadedAt: now, heartbeatAt: now },
    });
  }

  /**
   * An `updateMany`, which cannot recreate a row that is gone: the loader's
   * retry covers a record that failed. Swallows its own errors so a tick
   * cannot crash the scheduler; the next tick tries again. Requires
   * `ScheduleModule.forRoot()` in the host.
   */
  @Interval('plugin-load-heartbeat', PLUGIN_LOAD_HEARTBEAT_MS)
  async heartbeat(): Promise<void> {
    try {
      await this.systemActorScope.run('plugin-load-heartbeat', () =>
        this.db.pluginProcessLoad.updateMany({
          where: { processId: this.processId },
          data: { heartbeatAt: new Date() },
        }),
      );
    } catch (err) {
      this.logger.error(`Plugin load heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `apps/api/src/main.ts` handles its own signals and calls `app.close()`,
   * and `app.close()` is what runs this hook; no `enableShutdownHooks()` is
   * needed. A failed delete is logged, not thrown, so the other shutdown
   * hooks still run: the rows then go stale and the sweep stops honouring
   * them after `PLUGIN_LOAD_STALE_MS`.
   */
  async beforeApplicationShutdown(): Promise<void> {
    try {
      await this.systemActorScope.run('plugin-load-shutdown', () =>
        this.db.pluginProcessLoad.deleteMany({ where: { processId: this.processId } }),
      );
    } catch (err) {
      this.logger.error(`Failed to delete plugin load records: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
