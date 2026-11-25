import { extractPluginArchive, PluginArchiveRefusedError } from '@boardgamesempire/plugin-analysis';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import {
  isPlainJsonObject,
  PluginManifestValidationError,
  validatePluginManifest,
} from '@boardgamesempire/plugin-manifest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minVersion } from 'semver';
import type { ValidateOptions } from '../cli.js';
import { message } from '../messages.js';
import { ToolkitError } from '../toolkit.errors.js';

/** Thrown inside this module with the reason, then reported once as AGAINST_UNREADABLE. */
class AgainstReason extends Error {}

const readManifestText = async (path: string): Promise<string> => {
  if (!path.endsWith('.tgz')) {
    return readFile(path, 'utf8');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'bge-plugin-'));

  try {
    const intoDir = join(workDir, 'plugin');
    await extractPluginArchive(path, intoDir);

    return await readFile(join(intoDir, 'manifest.json'), 'utf8');
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
};

/**
 * The lowest version the earlier plugin manifest's `bgeCompat` range admits,
 * so it validates against a BGE it was written for: an earlier version of the
 * plugin may target an older BGE than `--bge-version`, and its range must
 * never block the comparison (#1093). Falls back to `--bge-version` when the
 * range does not parse; the validator then reports the range itself.
 */
const bgeVersionFor = (raw: Record<string, unknown>, fallback: string): string => {
  const range = raw['bgeCompat'];

  if (typeof range !== 'string') {
    return fallback;
  }

  try {
    return minVersion(range)?.version ?? fallback;
  } catch {
    return fallback;
  }
};

const reasonFor = (error: unknown): string | undefined => {
  if (error instanceof AgainstReason) {
    return error.message;
  }

  if (error instanceof PluginArchiveRefusedError) {
    return message(error.rule, error.entry === undefined ? {} : { entry: error.entry });
  }

  if (error instanceof PluginManifestValidationError) {
    const [first] = error.issues;

    return first === undefined
      ? undefined
      : `Its plugin manifest has an error at ${first.path}: ${first.message.replace(/\.$/, '')}.`;
  }

  if (error instanceof SyntaxError) {
    return 'Its manifest.json is not valid JSON.';
  }

  return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'There is no file there.' : undefined;
};

/**
 * Reads and validates the plugin manifest of an earlier version of the
 * plugin, given as its `manifest.json` or its plugin artifact (`.tgz`, opened
 * with the server's own extractor into a temporary folder that is always
 * removed), for the consent comparison (#1093). Any failure is one
 * AGAINST_UNREADABLE error at `path`.
 */
export const readAgainstManifest = async (
  path: string,
  options: ValidateOptions,
): Promise<PluginManifestValidationResult> => {
  try {
    const raw: unknown = JSON.parse(await readManifestText(path));

    if (!isPlainJsonObject(raw)) {
      throw new AgainstReason('Its manifest.json does not hold a JSON object.');
    }

    return validatePluginManifest(raw, {
      bgeVersion: bgeVersionFor(raw, options.bgeVersion),
      defaultLocale: options.defaultLocale,
    });
  } catch (error) {
    throw new ToolkitError('AGAINST_UNREADABLE', path, reasonFor(error));
  }
};
