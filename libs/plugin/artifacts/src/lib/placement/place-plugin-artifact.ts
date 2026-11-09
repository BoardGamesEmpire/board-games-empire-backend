import type { PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import { lstat, mkdir, rename, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Moves an extracted plugin artifact to `<root>/<slug>/<sha256>/` (#1094). The
 * rename is atomic, so of two identical posts at once one wins and the other
 * copy is discarded.
 *
 * An existing directory is touched: the sweep removes an unreferenced
 * directory once its mtime is over an hour old, and a re-post whose database
 * row just expired would otherwise be swept between this call and the new row.
 *
 * A slug directory that is a symbolic link is refused, and the extracted
 * directory is left for the caller to clean up. The loader refuses an
 * artifact behind a linked slug directory, and the sweep never follows a
 * link, so one placed through it could never load and never be swept.
 *
 * The check catches a link that is already there. It assumes that only the
 * server writes to the plugins root: the check and the rename are separate
 * steps, so a link swapped in between them is not caught.
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
  if ((await lstat(slugDir)).isSymbolicLink()) {
    throw new Error(`${slugDir} is a symbolic link; a plugin directory must be a directory inside the plugins root`);
  }

  try {
    await rename(extractDir, target);
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
