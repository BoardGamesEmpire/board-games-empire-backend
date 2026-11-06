import { PLUGIN_MANIFEST_FILENAME } from '@boardgamesempire/plugin-contract';
import { PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES, PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginArchiveRefusedError } from '../artifacts.errors';

/**
 * The slug an extracted plugin artifact declares, which names the directory it
 * is placed in. Refuses a manifest that is missing, not JSON, or whose slug is
 * not a valid plugin slug (`manifest-slug`), so a slug can never be a path.
 *
 * The runtime lib reads a manifest whole and sets no cap, so this one does: a
 * manifest over the archive rules' manifest cap is never read into memory
 * (`manifest-size`). The archive checker refuses such a manifest while it is
 * extracted, so this is the second line behind it (#1094).
 */
export const readArtifactSlug = async (extractDir: string): Promise<string> => {
  const path = join(extractDir, PLUGIN_MANIFEST_FILENAME);
  const refuse = () => new PluginArchiveRefusedError('manifest-slug', PLUGIN_MANIFEST_FILENAME);

  let parsed: unknown;
  try {
    if ((await stat(path)).size > PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES) {
      throw new PluginArchiveRefusedError('manifest-size', PLUGIN_MANIFEST_FILENAME);
    }
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw err instanceof PluginArchiveRefusedError ? err : refuse();
  }

  const slug = (parsed as { slug?: unknown } | null)?.slug;
  if (typeof slug !== 'string' || !PLUGIN_SLUG_PATTERN.test(slug)) {
    throw refuse();
  }

  return slug;
};
