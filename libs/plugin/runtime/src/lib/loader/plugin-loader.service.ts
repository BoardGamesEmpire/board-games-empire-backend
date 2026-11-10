import { PluginActorScope, SERVER_PLUGIN_UNIT, SystemActorScope } from '@bge/actor-context';
import { DatabaseService, isPrismaDependentRecordNotFoundError, type Plugin } from '@bge/database';
import {
  parsePluginArtifactSha256,
  type PluginArtifactSha256,
  type PluginFactory,
} from '@boardgamesempire/plugin-contract';
import { validatePluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { readFile } from 'node:fs/promises';
import { PluginConfigService } from '../config/plugin-config.service';
import { PluginContextFactory } from '../context/plugin-context.factory';
import { PluginDisabledEvent, PluginLoadFailedEvent } from '../events/plugin.events';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import type { PluginPackageDescriptor } from './entrypoint-resolver';
import { assertResolvedEntrypointContained, resolvePluginEntrypoint } from './entrypoint-resolver';
import { PluginDiskVersionMismatchError, PluginEntrypointError, PluginModuleShapeError } from './loader.errors';
import { PluginDirectoryResolverService } from './plugin-directory-resolver.service';
import { PluginInstanceRegistry } from './plugin-instance-registry';
import { PluginLoadRecorder } from './plugin-load-recorder.service';
import { PLUGIN_MODULE_IMPORTER, type PluginModuleImporter } from './plugin-module-importer';

/**
 * The boot path (#59 Phase B): loads every ENABLED plugin row, constructs
 * its context, invokes its factory inside a plugin-actor CLS scope, and
 * registers the product with `PluginInstanceRegistry`.
 *
 * Per-plugin isolation is the load-failure contract: a plugin whose
 * directory, manifest, entrypoint, import, or factory fails, or whose
 * artifact directory holds another version than the row's, is QUARANTINED
 * — `LoadFailed` provenance recorded, force-disabled in the DB (a
 * quarantined plugin must not auto-retry on every boot; re-enabling is an
 * explicit admin decision), logged at error level — and boot continues.
 * Fail-loud targets silent fallbacks; a lifecycle row, a disabled flag, and
 * an error log are loud, while a broken third-party plugin bricking a
 * self-hosted server would punish the operator for the plugin author's bug.
 *
 * The whole pass runs inside a `system` actor scope (`plugin-boot-load`) so
 * the quarantine mutations and their lifecycle rows are attributed; each
 * factory invocation additionally enters a `plugin` actor scope, so
 * anything a plugin does at construction time is attributed to the plugin
 * principal with the boot system actor as its trigger.
 *
 * The manifest is RE-VALIDATED from the stored `manifestJson` on every
 * load: the row was validated at install time, but the loader trusts the
 * validator, not the storage — a hand-edited or drifted row quarantines
 * instead of loading with unchecked shape.
 */
@Injectable()
export class PluginLoaderService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PluginLoaderService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly directories: PluginDirectoryResolverService,
    @Inject(PLUGIN_MODULE_IMPORTER) private readonly importer: PluginModuleImporter,
    private readonly contextFactory: PluginContextFactory,
    private readonly registry: PluginInstanceRegistry,
    private readonly configService: PluginConfigService,
    private readonly emitter: EventEmitter2,
    private readonly systemActorScope: SystemActorScope,
    private readonly pluginActorScope: PluginActorScope,
    private readonly recorder: PluginLoadRecorder,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.systemActorScope.run('plugin-boot-load', () => this.loadAllEnabled());
  }

  /**
   * Public for tests and future admin-triggered reload. Idempotent: an
   * already-registered slug is SKIPPED up front — re-running must not
   * re-import modules, re-run factory side effects, or trip the registry's
   * duplicate guard (whose throw would otherwise be routed into
   * `quarantine()` and force-disable a perfectly healthy plugin).
   */
  async loadAllEnabled(): Promise<void> {
    // `uninstalledAt: null` is belt-and-braces with the invariant that
    // uninstall force-disables: the tombstone predicate every C3+ query
    // carries is cheapest to keep locally true rather than provably implied.
    const plugins = await this.db.plugin.findMany({ where: { enabled: true, uninstalledAt: null } });

    this.logger.log(`Loading ${plugins.length} enabled plugin(s)`);

    for (const plugin of plugins) {
      if (this.registry.has(plugin.slug)) {
        this.logger.debug(`Plugin '${plugin.slug}' is already loaded — skipping`);
        continue;
      }

      try {
        await this.loadOne(plugin);
        this.logger.log(`Loaded plugin '${plugin.slug}' v${plugin.version} (${plugin.category})`);
      } catch (err) {
        await this.quarantine(plugin, err);
      }
    }
  }

  private async loadOne(plugin: Plugin): Promise<void> {
    const manifest = this.validateManifest(plugin);

    // Recorded before anything is read from the directory, resolving it
    // included (#1094). Recorded after the import, a sweep could remove it
    // mid-load, as when an update is approved during a rolling restart and
    // the process that ran the old code shuts down. This narrows that window
    // without closing it: the row was read before the earlier plugins loaded,
    // and a sweep that read what to keep before this record still walks
    // after it. A failed load never disables a plugin whose row has since
    // moved on (see quarantine). A load that fails after this keeps the
    // record until shutdown, and with it the directory, whose code may be
    // partly imported. A checksum that is not one records nothing; the
    // resolver refuses it.
    const sha256 = parsePluginArtifactSha256(plugin.installedSha256);
    if (sha256 !== null) {
      await this.recordLoad(plugin.slug, sha256);
    }

    const directory = await this.directories.resolve(plugin.slug, plugin.installedSha256);

    // Before anything else is read from the directory, and before any of its
    // code is imported. Every plugin artifact has a directory of its own
    // (#224), so the one installedSha256 names holds the version the row
    // activated; another version there is drift, not a staged update
    // awaiting consent, and loading it would run code nobody approved.
    const diskVersion = await this.readDiskVersion(directory.manifestPath);

    if (diskVersion !== plugin.version) {
      throw new PluginDiskVersionMismatchError(plugin.slug, plugin.version, diskVersion);
    }

    const descriptor = await this.readPackageDescriptor(plugin.slug, directory.packageJsonPath);
    const entrypoint = resolvePluginEntrypoint(plugin.slug, descriptor, directory.rootDir);
    // Symlink-aware containment re-check: the lexical check inside
    // `resolvePluginEntrypoint` cannot see a `dist -> /` style link.
    const realEntrypoint = await assertResolvedEntrypointContained(plugin.slug, entrypoint, directory.rootDir);

    const module = await this.importer.importModule(realEntrypoint);
    const factory = this.extractFactory(plugin.slug, module);

    // Prime BEFORE invoking the factory: a plugin reading config during
    // construction sees its stored value, not the empty default.
    this.configService.prime(plugin.slug, plugin.config);

    const context = this.contextFactory.create({ pluginId: plugin.id, slug: plugin.slug, manifest });
    // Boot loads have no consent unit to operate for — the plugin acts as
    // its Server-scope self until an invocation enters a unit scope (#60).
    const instance = await this.pluginActorScope.run(plugin.id, SERVER_PLUGIN_UNIT, 'plugin-boot-load', () =>
      Promise.resolve(factory(context)),
    );

    this.registry.register(
      plugin.slug,
      {
        pluginId: plugin.id,
        slug: plugin.slug,
        category: plugin.category,
        scope: plugin.scope,
        sha256: directory.sha256,
        manifest,
        instance,
      },
      { enabled: true },
    );

    // The code now running is the activated version — the disk check above
    // proved it — so a clean load is what clears both self-healing flags,
    // in one recovery write.
    if (plugin.loadFailed || plugin.restartRequired) {
      await this.db.plugin.update({
        where: { id: plugin.id },
        data: {
          ...(plugin.loadFailed ? { loadFailed: false, loadError: null } : {}),
          ...(plugin.restartRequired ? { restartRequired: false } : {}),
        },
      });

      if (plugin.loadFailed) {
        this.logger.log(`Plugin '${plugin.slug}' recovered from a prior load failure`);
      }

      if (plugin.restartRequired) {
        this.logger.log(`Plugin '${plugin.slug}' v${plugin.version} loaded post-update — restartRequired cleared`);
      }
    }
  }

  /**
   * Records the artifact this process is about to run (#1094). Its failure
   * never stops the load: it is logged, and the recorder's next heartbeat
   * writes the record again.
   */
  private async recordLoad(slug: string, sha256: PluginArtifactSha256): Promise<void> {
    try {
      await this.recorder.record(slug, sha256);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to record the artifact plugin '${slug}' runs; the next heartbeat writes it again: ${message}`,
      );
    }
  }

  /** The version named by the on-disk manifest, or `null` when it is missing, unreadable, or not a string. */
  private async readDiskVersion(manifestPath: string): Promise<string | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
      const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : null;

      return typeof version === 'string' ? version : null;
    } catch {
      return null;
    }
  }

  private validateManifest(plugin: Plugin): PluginManifest {
    const result = validatePluginManifest(plugin.manifestJson, {
      bgeVersion: this.options.bgeVersion,
      defaultLocale: this.options.defaultLocale,
    });

    return result.manifest;
  }

  private async readPackageDescriptor(slug: string, packageJsonPath: string): Promise<PluginPackageDescriptor> {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new PluginEntrypointError(slug, 'package.json is not a JSON object');
    }

    return parsed as PluginPackageDescriptor;
  }

  private extractFactory(slug: string, module: Record<string, unknown>): PluginFactory {
    const candidate = module['default'];

    if (typeof candidate !== 'function') {
      throw new PluginModuleShapeError(slug, `default export must be a factory function, got ${typeof candidate}`);
    }

    return candidate as PluginFactory;
  }

  /**
   * The load-failure contract. Ordering is deliberate: persist the
   * quarantine FIRST (the durable state matters most), then emit — the
   * lifecycle listener writes provenance post-commit from these events,
   * and the audit pipeline picks them up identically to any mutation.
   * Its own failure is caught and logged: one broken quarantine must not
   * abort the remaining plugins' boot.
   *
   * It disables the row only while the row still names the checksum this
   * process tried to load (#1094). An update approved, or an uninstall and
   * reinstall, while the load ran has moved the row on, and the old
   * artifact failing says nothing about the one the row names now; that
   * row is left as it is, with a warning, and nothing is emitted.
   */
  private async quarantine(plugin: Plugin, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Plugin '${plugin.slug}' failed to load — quarantining: ${message}`);

    // The snapshot may have been primed before the failure; a quarantined
    // plugin must not keep serving config or ride the refresh backstop.
    this.configService.evict(plugin.slug);

    try {
      const initiatedAt = new Date();
      const updated = await this.db.plugin.update({
        where: { id: plugin.id, installedSha256: plugin.installedSha256 },
        data: { enabled: false, loadFailed: true, loadError: message },
        select: { id: true, slug: true, enabled: true, loadFailed: true, loadError: true },
      });

      this.emitter.emit(
        PluginLoadFailedEvent.eventName,
        new PluginLoadFailedEvent(
          { id: plugin.id, slug: plugin.slug, loadFailed: plugin.loadFailed, loadError: plugin.loadError },
          { id: updated.id, slug: updated.slug, loadFailed: updated.loadFailed, loadError: updated.loadError },
          initiatedAt,
        ),
      );

      this.emitter.emit(
        PluginDisabledEvent.eventName,
        new PluginDisabledEvent(
          { id: plugin.id, slug: plugin.slug, enabled: plugin.enabled },
          { id: updated.id, slug: updated.slug, enabled: updated.enabled },
          initiatedAt,
        ),
      );
    } catch (persistErr) {
      if (isPrismaDependentRecordNotFoundError(persistErr)) {
        this.logger.warn(
          `Left plugin '${plugin.slug}' enabled: its row no longer names the artifact that failed to load`,
        );
        return;
      }

      this.logger.error(
        `Failed to persist quarantine for plugin '${plugin.slug}': ${
          persistErr instanceof Error ? persistErr.message : persistErr
        }`,
      );
    }
  }
}
