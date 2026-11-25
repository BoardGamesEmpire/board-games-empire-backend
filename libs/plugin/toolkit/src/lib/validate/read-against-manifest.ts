import { extractPluginArchive, PluginArchiveRefusedError } from '@boardgamesempire/plugin-analysis';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import {
  isPlainJsonObject,
  PluginManifestValidationError,
  validatePluginManifest,
} from '@boardgamesempire/plugin-manifest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { minVersion } from 'semver';
import { z } from 'zod';
import { isMissingPathError } from '../fs/is-file.js';
import { withTempDir } from '../fs/with-temp-dir.js';
import type { ValidateOptions } from '../options.js';
import { archiveRefusalItem } from '../stage/artifact-entries.js';
import { ToolkitError } from '../toolkit.errors.js';

/** The one field read before the validator runs; the validator judges it too (#1093, #1322). */
const bgeCompatSchema = z.object({ bgeCompat: z.string() });

/** Thrown inside this module with the reason, then reported once as AGAINST_UNREADABLE. */
class AgainstReason extends Error {}

const readManifestText = (path: string): Promise<string> =>
  path.endsWith('.tgz')
    ? withTempDir(async (workDir) => {
        const intoDir = join(workDir, 'plugin');
        await extractPluginArchive(path, intoDir);

        return readFile(join(intoDir, 'manifest.json'), 'utf8');
      })
    : readFile(path, 'utf8');

/**
 * The lowest version the earlier plugin manifest's `bgeCompat` range admits,
 * so it validates against a BGE it was written for: an earlier version of the
 * plugin may target an older BGE than `--bge-version`, and its range must
 * never block the comparison (#1093). Falls back to `--bge-version` when the
 * range does not parse; the validator then reports the range itself.
 */
const bgeVersionFor = (raw: unknown, fallback: string): string => {
  const parsed = bgeCompatSchema.safeParse(raw);

  if (!parsed.success) {
    return fallback;
  }

  try {
    return minVersion(parsed.data.bgeCompat)?.version ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * Why the earlier version could not be read, in a sentence for the report.
 * A failure nobody foresaw keeps its own words, so the plugin author still
 * learns what went wrong (#1093).
 */
const reasonFor = (error: unknown): string | undefined => {
  if (error instanceof AgainstReason) {
    return error.message;
  }

  if (error instanceof PluginArchiveRefusedError) {
    return archiveRefusalItem(error).message;
  }

  if (error instanceof SyntaxError) {
    return 'Its manifest.json is not valid JSON.';
  }

  if (isMissingPathError(error)) {
    return 'There is no file there.';
  }

  // Read by shape: under Jest, Node's own errors fail `instanceof Error`.
  return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
};

/**
 * Why an earlier version's plugin manifest fails today's validator, in a
 * sentence for the report (#1093).
 */
const invalidReason = (error: PluginManifestValidationError): string => {
  const [first] = error.issues;

  return first === undefined
    ? "The earlier version's plugin manifest no longer passes validation."
    : `The earlier version's plugin manifest no longer passes validation: it has an error at ${first.path}: ${first.message.replace(/\.$/, '')}.`;
};

/**
 * The earlier version's plugin manifest, validated, or why today's validator
 * refuses it. The second is not the plugin author's to fix (that version is
 * already out), so it skips the comparison instead of failing the run
 * (#1093).
 */
export type AgainstManifest =
  | { readonly kind: 'valid'; readonly manifest: PluginManifestValidationResult }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Reads and validates the plugin manifest of an earlier version of the
 * plugin, given as its `manifest.json` or its plugin artifact (`.tgz`, opened
 * with the server's own extractor into a temporary folder that is always
 * removed), for the consent comparison (#1093). A plugin manifest that reads
 * but fails today's validator comes back as `invalid`; any other failure
 * (no file, not JSON, an artifact the server would refuse) is one
 * AGAINST_UNREADABLE error at `path`, since the path itself is likely wrong.
 */
export const readAgainstManifest = async (path: string, options: ValidateOptions): Promise<AgainstManifest> => {
  try {
    const raw: unknown = JSON.parse(await readManifestText(path));

    if (!isPlainJsonObject(raw)) {
      throw new AgainstReason('Its manifest.json does not hold a JSON object.');
    }

    const manifest = validatePluginManifest(raw, {
      bgeVersion: bgeVersionFor(raw, options.bgeVersion),
      defaultLocale: options.defaultLocale,
    });

    return { kind: 'valid', manifest };
  } catch (error) {
    if (error instanceof PluginManifestValidationError) {
      return { kind: 'invalid', reason: invalidReason(error) };
    }

    throw new ToolkitError('AGAINST_UNREADABLE', path, reasonFor(error));
  }
};
