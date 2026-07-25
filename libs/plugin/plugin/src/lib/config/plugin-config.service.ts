import { DatabaseService } from '@bge/database';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PluginConfigEventsService } from './plugin-config-events.service';
import { PLUGIN_CONFIG_REFRESH_INTERVAL_MS, PLUGIN_CONFIG_REFRESH_INTERVAL_NAME } from './plugin-config.constants';

const EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Holder of per-plugin SERVER-scope config snapshots consumed through
 * `PluginContext.config`. The loader primes a snapshot per loaded plugin;
 * Redis pub/sub refreshes the affected slug on every committed config
 * change; a periodic backstop re-reads all known slugs to recover from a
 * message missed during a transient Redis disconnect.
 *
 * Concurrency model mirrors `SafeHttpPolicyService`: readers get the
 * current frozen snapshot reference; `refresh()` swaps the reference
 * atomically, so a reader mid-request sees the old snapshot or the new,
 * never a partial. Refresh failures retain the prior snapshot (the next
 * event or interval retries); a DELETED row drops the snapshot — the plugin
 * was uninstalled and serving stale config would mask that loudly-relevant
 * fact.
 */
@Injectable()
export class PluginConfigService implements OnModuleInit {
  private readonly logger = new Logger(PluginConfigService.name);
  private readonly snapshots = new Map<string, Readonly<Record<string, unknown>>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly events: PluginConfigEventsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.events.subscribe(async ({ slug }) => {
      await this.refresh(slug);
    });
  }

  /** Loader seam: installs the boot-time snapshot for a freshly loaded plugin. */
  prime(slug: string, config: unknown): void {
    this.snapshots.set(slug, this.normalize(slug, config));
  }

  /**
   * Loader seam: drops a snapshot outright. Used when a load is quarantined
   * after priming — a plugin that never came up must not keep serving config
   * or occupy a slot in the interval backstop. Unknown slugs are a no-op.
   */
  evict(slug: string): void {
    this.snapshots.delete(slug);
  }

  /**
   * Current snapshot for `slug`; the frozen empty object when nothing is
   * primed (a plugin reading config before/without any stored value gets a
   * stable, safe default rather than `undefined` branches).
   */
  snapshotFor(slug: string): Readonly<Record<string, unknown>> {
    return this.snapshots.get(slug) ?? EMPTY_CONFIG;
  }

  /** Re-reads one plugin's config from DB and swaps its snapshot. */
  async refresh(slug: string): Promise<void> {
    try {
      const row = await this.db.plugin.findUnique({ where: { slug }, select: { config: true } });

      if (row === null) {
        this.snapshots.delete(slug);
        this.logger.warn(`Plugin '${slug}' no longer exists — dropped its config snapshot`);
        return;
      }

      this.snapshots.set(slug, this.normalize(slug, row.config));
      this.logger.debug(`Config snapshot refreshed for plugin '${slug}'`);
    } catch (err) {
      this.logger.error(
        `Failed to refresh config for plugin '${slug}' — retaining existing snapshot: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Periodic backstop over every known slug. Only fires in apps that
   * register `ScheduleModule.forRoot()`; `refresh()` swallows its own
   * errors, so a tick can never crash the scheduler.
   */
  @Interval(PLUGIN_CONFIG_REFRESH_INTERVAL_NAME, PLUGIN_CONFIG_REFRESH_INTERVAL_MS)
  async refreshOnInterval(): Promise<void> {
    for (const slug of this.snapshots.keys()) {
      await this.refresh(slug);
    }
  }

  /**
   * `Plugin.config` is a Json column governed by the manifest's
   * `config.schema` — an object in every legitimate state. A non-object
   * (hand-edited row, migration anomaly) is normalized to the empty
   * snapshot with a loud log rather than handing plugins a scalar where
   * they expect a record.
   */
  private normalize(slug: string, config: unknown): Readonly<Record<string, unknown>> {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      this.logger.error(`Plugin '${slug}' config is not an object (got ${typeof config}) — serving empty config`);
      return EMPTY_CONFIG;
    }

    return Object.freeze({ ...(config as Record<string, unknown>) });
  }
}
