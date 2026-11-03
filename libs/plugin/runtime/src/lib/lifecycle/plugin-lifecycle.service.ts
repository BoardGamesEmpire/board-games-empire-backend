import type { PluginUnit } from '@bge/actor-context';
import { DatabaseService, Prisma, type Plugin } from '@bge/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  PluginConfigUpdatedEvent,
  PluginDisabledEvent,
  PluginEnabledEvent,
  PluginUninstalledEvent,
} from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { PluginInstanceRegistry } from '../loader/plugin-instance-registry';
import { bindManifest, classifyManifestMove, type ClaimedPluginRow } from '../manifest/manifest-move';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { CLEARED_STAGED_UPDATE } from '../update/staged-update.columns';
import {
  PluginLifecycleAuthorityError,
  PluginLifecycleManifestError,
  PluginLifecycleNotFoundError,
  PluginLifecyclePluginChangedError,
  PluginLifecycleTombstonedError,
  PluginUninstallBundledError,
} from './lifecycle.errors';

export interface PluginLifecycleActionInput {
  readonly slug: string;

  /**
   *  The acting admin — resolved from CLS at the API edge, verified here, never taken from a request body.
   */
  readonly actorId: string;
}

export interface PluginConfigWriteInput extends PluginLifecycleActionInput {
  readonly config: Record<string, unknown>;
}

export interface PluginUninstallInput extends PluginLifecycleActionInput {
  /** Also delete retained household/user config rows; default false — the tombstone exists to preserve them for a reinstall. */
  readonly purgeData?: boolean;
}

export interface PluginUninstallResult {
  readonly plugin: Plugin;
  /** Household/user units that had the plugin enabled at uninstall time — the announcement seam (#324). */
  readonly affectedUnits: readonly PluginUnit[];
}

/**
 * Server-level plugin lifecycle (#320): the admin's enable/disable switch,
 * the server config write, and uninstall — the first writer of
 * `uninstalledAt`.
 *
 * Two consumers of every state flip, in order: the in-process
 * `PluginInstanceRegistry` (the DB write alone does not stop a loaded
 * instance from serving; cross-instance propagation is #332, `restartRequired`
 * is the cross-instance story until then), then the lifecycle event,
 * emitted post-commit like every other writer here.
 *
 * Enable/disable are idempotent: a request that matches current state
 * returns it unchanged — no write, no event (a mutation event whose before
 * and after agree is noise). The flag write is guarded on the prior state
 * inside the transaction so a race cannot double-emit; the loser resolves
 * to the winner's outcome.
 *
 * Uninstall (tombstone, not delete): purges every `PluginGrant` (durable
 * denials included — reinstall is fresh consent) and the `PluginPermission`
 * catalog, retains the row and, by default, unit config rows; clears any
 * staged update (the cleared columns are the staged-file cleanup signal for
 * the #84 ingress pipeline); force-disables alongside the tombstone — the
 * loader's boot query treats that as an invariant — and sets
 * `restartRequired` so diagnostics show the running instance still holds
 * the old module until next boot. No hot unload, by design.
 */
@Injectable()
export class PluginLifecycleService {
  private readonly logger = new Logger(PluginLifecycleService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly registry: PluginInstanceRegistry,
    private readonly configSchema: PluginConfigSchemaService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  async enable(input: PluginLifecycleActionInput): Promise<Plugin> {
    return this.setEnabled(input, true);
  }

  async disable(input: PluginLifecycleActionInput): Promise<Plugin> {
    return this.setEnabled(input, false);
  }

  async updateConfig(input: PluginConfigWriteInput): Promise<Plugin> {
    const initiatedAt = new Date();
    await this.assertServerAdmin(input.actorId);
    const plugin = await this.loadLiving(input.slug);

    const validated = revalidateStoredManifest(
      plugin,
      this.options,
      (pluginSlug, detail, issues) => new PluginLifecycleManifestError(pluginSlug, detail, issues),
    );

    const issues = this.configSchema.validate({
      slug: plugin.slug,
      version: plugin.version,
      schema: validated.manifest.config.schema,
      config: input.config,
    });

    if (issues.length > 0) {
      throw new PluginConfigValidationError(plugin.slug, issues);
    }

    // Last-writer-wins still holds between PATCHes: no version precondition,
    // matching the system-settings PATCH. What it does not hold across is a
    // plugin manifest replacement: the document above was validated against
    // the plugin manifest read before this transaction, so the row is claimed
    // first and compared against exactly that read (#578).
    //
    // The claim is `FOR NO KEY UPDATE`, the mode the config write takes
    // anyway. `FOR SHARE` would be upgraded by that write, and two PATCHes
    // each holding a share lock would deadlock. `FOR UPDATE` would also make
    // every grant or unit insert for this plugin wait out the PATCH, because
    // it conflicts with the `FOR KEY SHARE` their foreign key takes. This mode
    // still queues a second PATCH and still waits for activation's
    // `FOR UPDATE`, an uninstall's write and the unit paths' `FOR SHARE`.
    //
    // The claim has seen `uninstalled_at` NULL and holds the row until commit,
    // so no uninstall can land before the write and the write needs no guard
    // of its own. It also reads `config`, so the event's before-snapshot is
    // the document this write replaced, not the one the pre-transaction read
    // saw: a PATCH queued behind another reports the change from that one's
    // document.
    const { before, updated } = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        (ClaimedPluginRow & { config: Prisma.JsonValue })[]
      >`SELECT uninstalled_at, version, installed_at, config, manifest_json = ${bindManifest(plugin.manifestJson)}::jsonb AS manifest_matches
        FROM plugins WHERE id = ${plugin.id} FOR NO KEY UPDATE`;
      const row = rows[0];

      if (row === undefined) {
        throw new PluginLifecycleNotFoundError(plugin.slug);
      }

      if (row.uninstalled_at !== null) {
        throw new PluginLifecycleTombstonedError(plugin.slug, row.uninstalled_at);
      }

      const moved = classifyManifestMove(row, plugin);

      if (moved !== null) {
        throw new PluginLifecyclePluginChangedError(plugin.slug, moved, plugin.version, row.version);
      }

      const written = await tx.plugin.update({
        where: { id: plugin.id },
        data: { config: input.config as Prisma.InputJsonValue },
      });

      return { before: row.config, updated: written };
    });

    // The reload needs no direct publish: the lifecycle listener is the
    // single publish site for the config channel and reacts to this event.
    this.emitter.emit(
      PluginConfigUpdatedEvent.eventName,
      new PluginConfigUpdatedEvent(
        { id: plugin.id, slug: plugin.slug, config: before },
        { id: updated.id, slug: updated.slug, config: updated.config },
        initiatedAt,
      ),
    );

    return updated;
  }

  async uninstall(input: PluginUninstallInput): Promise<PluginUninstallResult> {
    const initiatedAt = new Date();
    await this.assertServerAdmin(input.actorId);
    const plugin = await this.loadLiving(input.slug);

    if (plugin.bundled) {
      throw new PluginUninstallBundledError(plugin.slug);
    }

    const { updated, affectedUnits } = await this.db.$transaction(async (tx) => {
      const claimed = await tx.plugin.updateMany({
        where: { id: plugin.id, uninstalledAt: null },
        data: {
          enabled: false,
          uninstalledAt: initiatedAt,
          restartRequired: true,
          ...CLEARED_STAGED_UPDATE,
        },
      });

      if (claimed.count !== 1) {
        throw new PluginLifecycleTombstonedError(plugin.slug, await this.readTombstone(tx, plugin.slug, initiatedAt));
      }

      // Captured AFTER the claim and BEFORE the purge, and both halves are
      // load-bearing. Before the purge because under `purgeData` these rows
      // are gone by commit time, and the event payload is the only durable
      // record of who the removal affected. After the claim because a unit
      // writer racing this transaction is ordered by the claim's row lock,
      // not by anything earlier: the unit paths read the plugin row
      // `FOR SHARE` (#323), so one that got its share lock first blocks the
      // claim until it commits — and is then visible to this read — while
      // one arriving later blocks on the claim and refuses over the
      // tombstone it sees. Read before the claim, a first enable committing
      // in that window is purged without ever being announced, and the
      // household is never told the plugin it just turned on is gone.
      const affectedHouseholds = await tx.householdPlugin.findMany({
        where: { pluginId: plugin.id, enabled: true },
        select: { householdId: true },
      });
      const affectedUsers = await tx.userPlugin.findMany({
        where: { pluginId: plugin.id, enabled: true },
        select: { userId: true },
      });

      await tx.pluginGrant.deleteMany({ where: { pluginId: plugin.id } });
      await tx.pluginPermission.deleteMany({ where: { pluginId: plugin.id } });

      if (input.purgeData === true) {
        await tx.householdPlugin.deleteMany({ where: { pluginId: plugin.id } });
        await tx.userPlugin.deleteMany({ where: { pluginId: plugin.id } });
      }

      const row = await tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });

      const units: PluginUnit[] = [
        ...affectedHouseholds.map((unit): PluginUnit => ({ scopeType: 'Household', householdId: unit.householdId })),
        ...affectedUsers.map((unit): PluginUnit => ({ scopeType: 'User', userId: unit.userId })),
      ];

      return { updated: row, affectedUnits: units };
    });

    // Drop the loaded instance from serving; the module itself stays in
    // memory until restart (no hot unload) — `restartRequired` records that.
    if (this.registry.has(plugin.slug)) {
      this.registry.unregister(plugin.slug);
    }

    this.emitter.emit(
      PluginUninstalledEvent.eventName,
      new PluginUninstalledEvent(
        { id: plugin.id, slug: plugin.slug, version: plugin.version, bundled: plugin.bundled },
        affectedUnits,
        initiatedAt,
      ),
    );

    this.logger.log(
      `Uninstalled plugin '${plugin.slug}'@${plugin.version}: ${affectedUnits.length} enabled unit(s) affected` +
        (input.purgeData === true ? ', unit config purged' : ''),
    );

    return { plugin: updated, affectedUnits };
  }

  private async setEnabled(input: PluginLifecycleActionInput, enabled: boolean): Promise<Plugin> {
    const initiatedAt = new Date();
    await this.assertServerAdmin(input.actorId);
    const plugin = await this.loadLiving(input.slug);

    if (plugin.enabled === enabled) {
      return plugin;
    }

    // Cold enable: the loader boots only enabled rows, so a plugin disabled
    // at boot (or quarantined) holds no in-process instance to flip — the DB
    // will say enabled while nothing serves. restartRequired makes that gap
    // visible; the loader's success path clears it on the boot that loads
    // the plugin. A warm flip serves immediately and needs no flag.
    const coldEnable = enabled && !this.registry.has(plugin.slug);

    const updated = await this.db.$transaction(async (tx) => {
      const claimed = await tx.plugin.updateMany({
        where: { id: plugin.id, enabled: !enabled, uninstalledAt: null },
        data: { enabled, ...(coldEnable ? { restartRequired: true } : {}) },
      });

      if (claimed.count !== 1) {
        return null;
      }

      return tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } });
    });

    // Lost the race: the state moved underneath us. Re-reading resolves to
    // the winner's outcome (or its fresh tombstone) — the winner emitted.
    if (updated === null) {
      return this.loadLiving(input.slug);
    }

    if (this.registry.has(plugin.slug)) {
      this.registry.setEnabled(plugin.slug, enabled);
    }

    const snapshotBefore = { id: plugin.id, slug: plugin.slug, enabled: plugin.enabled };
    const snapshotAfter = { id: updated.id, slug: updated.slug, enabled: updated.enabled };

    if (enabled) {
      this.emitter.emit(
        PluginEnabledEvent.eventName,
        new PluginEnabledEvent(snapshotBefore, snapshotAfter, initiatedAt),
      );
    } else {
      this.emitter.emit(
        PluginDisabledEvent.eventName,
        new PluginDisabledEvent(snapshotBefore, snapshotAfter, initiatedAt),
      );
    }

    return updated;
  }

  private async assertServerAdmin(actorId: string): Promise<void> {
    if (!(await this.authority.isServerAdmin(actorId))) {
      throw new PluginLifecycleAuthorityError(actorId);
    }
  }

  /** Loads the row for a living (non-tombstoned) plugin or throws the not-found/tombstoned guard. */
  private async loadLiving(slug: string): Promise<Plugin> {
    const plugin = await this.db.plugin.findUnique({ where: { slug } });

    if (plugin === null) {
      throw new PluginLifecycleNotFoundError(slug);
    }

    if (plugin.uninstalledAt !== null) {
      throw new PluginLifecycleTombstonedError(plugin.slug, plugin.uninstalledAt);
    }

    return plugin;
  }

  /**
   * For race-path errors: the winner's actual tombstone time when readable,
   * the loser's clock otherwise. Reads through the CALLER'S transaction
   * client — the open transaction already holds a pooled connection, and
   * reaching around it for a second one risks starving the pool at exactly
   * the moment it is contended. Read Committed makes the winner's commit
   * visible to this statement regardless.
   */
  private async readTombstone(tx: Prisma.TransactionClient, slug: string, fallback: Date): Promise<Date> {
    const row = await tx.plugin.findUnique({ where: { slug }, select: { uninstalledAt: true } });

    return row?.uninstalledAt ?? fallback;
  }
}
