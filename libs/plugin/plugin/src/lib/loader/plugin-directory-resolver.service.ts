import { PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { access, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import {
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_PACKAGE_JSON_FILENAME,
  type InstalledPluginDirectory,
} from './installed-plugin-directory';
import { PluginDirectoryLayoutError, PluginDirectoryNotFoundError } from './loader.errors';

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

    const root = resolve(bundled ? this.options.bundledRoot : this.options.pluginsRoot);
    const rootDir = join(root, slug);

    const rootStat = await stat(rootDir).catch(() => null);
    if (rootStat === null || !rootStat.isDirectory()) {
      throw new PluginDirectoryNotFoundError(slug, rootDir);
    }

    const manifestPath = join(rootDir, PLUGIN_MANIFEST_FILENAME);
    const packageJsonPath = join(rootDir, PLUGIN_PACKAGE_JSON_FILENAME);

    await this.assertFile(slug, manifestPath, PLUGIN_MANIFEST_FILENAME);
    await this.assertFile(slug, packageJsonPath, PLUGIN_PACKAGE_JSON_FILENAME);

    return { slug, rootDir, manifestPath, packageJsonPath, bundled };
  }

  private async assertFile(slug: string, path: string, filename: string): Promise<void> {
    try {
      await access(path);
    } catch {
      throw new PluginDirectoryLayoutError(slug, `missing ${filename} at directory root`);
    }
  }
}
