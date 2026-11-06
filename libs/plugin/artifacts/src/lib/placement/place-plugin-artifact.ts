import type { PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import { mkdir, rename, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Renames the extracted directory to its checksum path. The artifact sweep
 * leaves slug directories alone, but something else, such as a manual
 * `rmdir`, may still remove the slug directory between the `mkdir` before
 * this and the rename (#1094). A rename that finds no slug directory makes it
 * again and tries once more; a second failure propagates, as any other
 * failure does.
 */
const renameIntoSlugDirectory = async (extractDir: string, slugDir: string, target: string): Promise<void> => {
  try {
    await rename(extractDir, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }

    await mkdir(slugDir, { recursive: true });
    await rename(extractDir, target);
  }
};

/**
 * Moves an extracted plugin artifact to `<root>/<slug>/<sha256>/` (#1094). The
 * rename is atomic, so of two identical posts at once one wins and the other
 * copy is discarded.
 *
 * An existing directory is touched: the sweep removes an unreferenced
 * directory once its mtime is over an hour old, and a re-post whose database
 * row just expired would otherwise be swept between this call and the new row.
 */
export const placePluginArtifact = async (
  extractDir: string,
  pluginsRoot: string,
  slug: string,
  sha256: PluginArtifactSha256,
): Promise<'placed' | 'already-present'> => {
  // A slug is a plain string and becomes a path. `readArtifactSlug` checks it
  // first, so a failure here is a caller's bug, not an archive's.
  if (!PLUGIN_SLUG_PATTERN.test(slug)) {
    throw new Error(`${JSON.stringify(slug)} is not a plugin slug, so it cannot name a directory`);
  }

  const slugDir = join(pluginsRoot, slug);
  const target = join(slugDir, sha256);

  await mkdir(slugDir, { recursive: true });

  try {
    await renameIntoSlugDirectory(extractDir, slugDir, target);
    return 'placed';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
      throw err;
    }
  }

  const now = new Date();
  await utimes(target, now, now);
  await rm(extractDir, { recursive: true, force: true });

  return 'already-present';
};
