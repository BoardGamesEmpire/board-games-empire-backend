import { PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { valid } from 'semver';
import { z } from 'zod';

/** npm's own top-level folder name, the name used when the plugin manifest gives no usable slug and version. */
export const FALLBACK_ARTIFACT_NAME = 'package';

/**
 * The two plugin manifest fields the name comes from, read before the
 * validator runs. The validator judges the rest, and reports these two
 * fields itself when they are wrong (#1093, #1322).
 */
const nameFieldsSchema = z.object({
  slug: z.string().regex(PLUGIN_SLUG_PATTERN),
  version: z.string(),
});

/**
 * `<slug>-<version>`: the plugin artifact's top-level folder and, with
 * `.tgz`, its file name (#1093). Only a slug the server accepts and a version
 * semver reads name it, the version as semver writes it (`v1.2.0` gives
 * `1.2.0`). Anything else, a plugin manifest that is not JSON included, gives
 * `package`, so a bad slug or version is reported once, by the validator,
 * never as an archive rule the plugin author didn't break.
 */
export const artifactNameFor = (manifestText: string): string => {
  let json: unknown;

  try {
    json = JSON.parse(manifestText);
  } catch {
    return FALLBACK_ARTIFACT_NAME;
  }

  const parsed = nameFieldsSchema.safeParse(json);
  const version = parsed.success ? valid(parsed.data.version) : null;

  return parsed.success && version !== null ? `${parsed.data.slug}-${version}` : FALLBACK_ARTIFACT_NAME;
};

/**
 * The name `artifactNameFor` gives the `manifest.json` in `rootDir`, or
 * `package` when there is none to read: the plugin manifest's own check
 * reports that (#1093).
 */
export const readArtifactName = async (rootDir: string): Promise<string> => {
  let manifestText: string;

  try {
    manifestText = await readFile(join(rootDir, 'manifest.json'), 'utf8');
  } catch {
    return FALLBACK_ARTIFACT_NAME;
  }

  return artifactNameFor(manifestText);
};
