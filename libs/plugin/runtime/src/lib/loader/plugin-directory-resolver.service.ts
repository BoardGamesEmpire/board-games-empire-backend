import {
  PLUGIN_ARTIFACT_SHA256_PATTERN,
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_PACKAGE_JSON_FILENAME,
  parsePluginArtifactSha256,
  type PluginArtifactDirectory,
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

    const parsed = parsePluginArtifactSha256(sha256);

    if (parsed === null) {
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

    const artifactPath = join(realRoot, slug, parsed);
    const artifactStat = await stat(artifactPath).catch(() => null);

    if (artifactStat === null || !artifactStat.isDirectory()) {
      throw new PluginDirectoryNotFoundError(slug, artifactPath);
    }

    // The slug directory or the artifact directory may be a symlink; a link
    // out of the configured root would otherwise let every subsequent layout
    // check pass against a host location. Checking the final realpath covers
    // a link out of the root at either segment.
    const rootDir = await realpathOrNull(artifactPath);

    if (rootDir === null || !isContained(realRoot, rootDir)) {
      throw new PluginDirectoryLayoutError(slug, `directory resolves outside the configured plugin root ${realRoot}`);
    }

    // A link that stays inside the root is refused too. The directory's name
    // is its identity (#224): `<root>/plugin-a/<sha>` linked to plugin-b's
    // artifact would load plugin-b's code under plugin-a's row, its grants and
    // its config, and the loader's version check can't tell the two apart
    // when the versions agree. `realRoot` is already real, so the artifact
    // path is its own realpath exactly when neither segment is a link.
    if (rootDir !== artifactPath) {
      throw new PluginDirectoryLayoutError(
        slug,
        `artifact directory ${artifactPath} is a link to ${rootDir}; it must be the directory its checksum names`,
      );
    }

    const manifestPath = join(rootDir, PLUGIN_MANIFEST_FILENAME);
    const packageJsonPath = join(rootDir, PLUGIN_PACKAGE_JSON_FILENAME);

    await this.assertContainedFile(slug, manifestPath, PLUGIN_MANIFEST_FILENAME, rootDir);
    await this.assertContainedFile(slug, packageJsonPath, PLUGIN_PACKAGE_JSON_FILENAME, rootDir);

    return { slug, sha256: parsed, rootDir, manifestPath, packageJsonPath };
  }

  /**
   * The artifact directory a caller handed over, checked against the one
   * this resolver finds for its slug and checksum, so install and stage
   * record only a checksum the loader can resolve at the next boot (#224).
   * A caller's directory elsewhere (a temporary extraction directory, say)
   * is refused, as is a checksum that is not 64 lowercase hex characters.
   * Returns the resolved directory, whose paths the caller reads from.
   *
   * The two are compared as real paths: `resolve()` answers with one, and a
   * caller that builds the path from a configured root behind a symlink (a
   * bind mount, or macOS's `/var` → `/private/var`) names the same directory
   * in a different spelling. Only the resolver's paths are returned, so the
   * spelling a caller used is never read from.
   */
  async confirm(directory: PluginArtifactDirectory): Promise<PluginArtifactDirectory> {
    const resolved = await this.resolve(directory.slug, directory.sha256);

    if ((await realpathOrNull(directory.rootDir)) !== resolved.rootDir) {
      throw new PluginDirectoryLayoutError(
        directory.slug,
        `directory ${directory.rootDir} is not the artifact directory ${resolved.rootDir} its checksum names`,
      );
    }

    return resolved;
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
