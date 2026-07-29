import {
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_PACKAGE_JSON_FILENAME,
  type InstalledPluginDirectory,
} from '@boardgamesempire/plugin-contract';
import { PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import { PluginDirectoryLayoutError, PluginDirectoryNotFoundError } from './loader.errors';
import { isContained, realpathOrNull } from './path-containment';

/**
 * Maps a `Plugin` row to its on-disk `InstalledPluginDirectory`. Two roots:
 *
 * - `pluginsRoot/<slug>` — tarball installs, populated by the #84 pipeline.
 * - `bundledRoot/<slug>` — plugins shipped in-tree with BGE. Rows are
 *   seeded by the consuming issues (#61/#194) — this branch carries no
 *   seeds itself, only the resolution + layout validation. Uninstall
 *   refusal for bundled plugins is enforced where uninstall lands (Phase C);
 *   the loader-side invariant is simply that bundled rows never resolve
 *   into the install root.
 *
 * The slug is re-checked against `PLUGIN_SLUG_PATTERN` even though every DB
 * row originated from a validated manifest: the slug becomes a filesystem
 * path segment here, and a corrupted/hand-edited row must fail loudly
 * rather than traverse (`../../…`) out of the roots.
 */
@Injectable()
export class PluginDirectoryResolverService {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions) {}

  async resolve(slug: string, bundled: boolean): Promise<InstalledPluginDirectory> {
    if (!PLUGIN_SLUG_PATTERN.test(slug)) {
      throw new PluginDirectoryLayoutError(
        slug,
        `slug fails ${String(PLUGIN_SLUG_PATTERN)} and cannot be a path segment`,
      );
    }

    const configuredRoot = resolve(bundled ? this.options.bundledRoot : this.options.pluginsRoot);
    const realRoot = await realpathOrNull(configuredRoot);

    if (realRoot === null) {
      throw new PluginDirectoryLayoutError(slug, `configured plugin root '${configuredRoot}' cannot be resolved`);
    }

    const rootStat = await stat(join(realRoot, slug)).catch(() => null);

    if (rootStat === null || !rootStat.isDirectory()) {
      throw new PluginDirectoryNotFoundError(slug, join(realRoot, slug));
    }

    // The plugin directory itself may be a symlink; a link out of the
    // configured root would otherwise let every subsequent layout check pass
    // against a host location.
    const rootDir = await realpathOrNull(join(realRoot, slug));

    if (rootDir === null || !isContained(realRoot, rootDir)) {
      throw new PluginDirectoryLayoutError(slug, `directory resolves outside the configured plugin root ${realRoot}`);
    }

    const manifestPath = join(rootDir, PLUGIN_MANIFEST_FILENAME);
    const packageJsonPath = join(rootDir, PLUGIN_PACKAGE_JSON_FILENAME);

    await this.assertContainedFile(slug, manifestPath, PLUGIN_MANIFEST_FILENAME, rootDir);
    await this.assertContainedFile(slug, packageJsonPath, PLUGIN_PACKAGE_JSON_FILENAME, rootDir);

    return { slug, rootDir, manifestPath, packageJsonPath, bundled };
  }

  /**
   * Asserts a REGULAR FILE that provably lives inside the plugin directory.
   *
   * Existence alone is insufficient on both axes. `access()` would accept a
   * directory named `manifest.json`, deferring the diagnosis to an opaque
   * read error downstream. And `stat()` follows symlinks, so a
   * `package.json` linked to a host path would satisfy a naive check and
   * then be read and parsed by the loader — whose JSON parse errors are
   * persisted verbatim into `Plugin.loadError`, making a plugin author's
   * layout a weak read primitive against host files. Containment is
   * therefore asserted against `realpath`, matching the entrypoint guard.
   */
  private async assertContainedFile(slug: string, path: string, filename: string, rootDir: string): Promise<void> {
    const entry = await stat(path).catch(() => null);

    if (entry === null || !entry.isFile()) {
      throw new PluginDirectoryLayoutError(slug, `${filename} at directory root is missing or not a regular file`);
    }

    const realPath = await realpathOrNull(path);

    if (realPath === null || !isContained(rootDir, realPath)) {
      throw new PluginDirectoryLayoutError(slug, `${filename} resolves outside the plugin directory`);
    }
  }
}
