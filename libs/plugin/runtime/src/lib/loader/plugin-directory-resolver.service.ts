import {
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_PACKAGE_JSON_FILENAME,
  type PluginArtifactDirectory,
} from '@boardgamesempire/plugin-contract';
import { PLUGIN_ARTIFACT_SHA256_PATTERN, PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import { PluginDirectoryLayoutError, PluginDirectoryNotFoundError } from './loader.errors';
import { isContained, realpathOrNull } from './path-containment';

/**
 * Maps a plugin artifact to its on-disk `PluginArtifactDirectory`,
 * `<pluginsRoot>/<slug>/<sha256>/`, where the install ingress is to place it (planned, #1094). The
 * loader asks for the artifact a row's `installedSha256` names; a staged
 * update's files are the directory its `pendingSha256` names. There is one
 * root, because no plugin ships inside the server (#696).
 *
 * The slug and the checksum are re-checked against their patterns even
 * though both reached the row through validation: each becomes a filesystem
 * path segment here, and a corrupted/hand-edited row must fail loudly
 * rather than traverse (`../../…`) out of the root.
 */
@Injectable()
export class PluginDirectoryResolverService {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions) {}

  async resolve(slug: string, sha256: string): Promise<PluginArtifactDirectory> {
    if (!PLUGIN_SLUG_PATTERN.test(slug)) {
      throw new PluginDirectoryLayoutError(
        slug,
        `slug fails ${String(PLUGIN_SLUG_PATTERN)} and cannot be a path segment`,
      );
    }

    if (!PLUGIN_ARTIFACT_SHA256_PATTERN.test(sha256)) {
      throw new PluginDirectoryLayoutError(
        slug,
        `checksum fails ${String(PLUGIN_ARTIFACT_SHA256_PATTERN)} and cannot be a path segment`,
      );
    }

    const configuredRoot = resolve(this.options.pluginsRoot);
    const realRoot = await realpathOrNull(configuredRoot);

    if (realRoot === null) {
      throw new PluginDirectoryLayoutError(slug, `configured plugin root '${configuredRoot}' cannot be resolved`);
    }

    const artifactPath = join(realRoot, slug, sha256);
    const rootStat = await stat(artifactPath).catch(() => null);

    if (rootStat === null || !rootStat.isDirectory()) {
      throw new PluginDirectoryNotFoundError(slug, artifactPath);
    }

    // The slug directory or the artifact directory may be a symlink; a link
    // out of the configured root would otherwise let every subsequent layout
    // check pass against a host location. Checking the final realpath covers
    // a link at either segment.
    const rootDir = await realpathOrNull(artifactPath);

    if (rootDir === null || !isContained(realRoot, rootDir)) {
      throw new PluginDirectoryLayoutError(slug, `directory resolves outside the configured plugin root ${realRoot}`);
    }

    const manifestPath = join(rootDir, PLUGIN_MANIFEST_FILENAME);
    const packageJsonPath = join(rootDir, PLUGIN_PACKAGE_JSON_FILENAME);

    await this.assertContainedFile(slug, manifestPath, PLUGIN_MANIFEST_FILENAME, rootDir);
    await this.assertContainedFile(slug, packageJsonPath, PLUGIN_PACKAGE_JSON_FILENAME, rootDir);

    return { slug, sha256, rootDir, manifestPath, packageJsonPath };
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
