import { quoteUntrustedText } from '@boardgamesempire/plugin-analysis';
import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { isFile } from '../fs/is-file.js';
import { message } from '../messages.js';
import { describeNpmFailure, NpmCommandError, runNpm } from '../npm/run-npm.js';
import type { ReportItem } from '../report.js';
import { ToolkitError } from '../toolkit.errors.js';
import { compareBytewise } from './artifact-entries.js';

/**
 * The files a plugin artifact holds are the ones npm would publish, so a
 * plugin author steers them with the `files` field and `.npmignore` they
 * already know (#1093). `--ignore-scripts`: listing files never runs the
 * plugin's own code.
 */
const PACK_ARGS = ['pack', '--dry-run', '--json', '--ignore-scripts'] as const;

/**
 * npm never packs `package-lock.json`, and a `files` field that leaves out
 * `manifest.json` would leave the plugin without one; every plugin artifact
 * needs both (#1093).
 */
const ALWAYS_SELECTED = ['manifest.json', 'package-lock.json'] as const;

export interface SelectPluginFilesOptions {
  /**
   * A folder relative to the project, with `/` separators, whose files are
   * left out: the build's output folder, so an earlier plugin artifact is
   * never packed into the next (#1093).
   */
  readonly excludeDir?: string;
}

/**
 * The part of `npm pack --dry-run --json`'s output the selection reads: one
 * entry per packed project, listing its files by path. npm prints more about
 * each, which is left alone (#1093, #1322).
 */
const packListingSchema = z.tuple(
  [z.looseObject({ files: z.array(z.looseObject({ path: z.string() })) })],
  z.unknown(),
);

/** The `files[].path` of npm's dry-run listing, or undefined when it has another shape. */
const packedPaths = (stdout: string): string[] | undefined => {
  let json: unknown;

  try {
    json = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  const parsed = packListingSchema.safeParse(json);

  return parsed.success ? parsed.data[0].files.map((file) => file.path) : undefined;
};

/**
 * The NPM_PACK_FAILED error for a failed dry run (#1093). When npm never
 * started, or was cut off (its output overran the buffer, a signal), the
 * package.json is not the problem, so the detail says npm could not be run.
 * Otherwise it points at package.json and quotes what npm said.
 */
export const npmPackFailure = (error: NpmCommandError): ToolkitError =>
  new ToolkitError(
    'NPM_PACK_FAILED',
    undefined,
    error.exitCode === null
      ? describeNpmFailure(error)
      : `Check that the folder holds a valid package.json. ${describeNpmFailure(error)}`,
  );

/**
 * npm walks up to the nearest ancestor with a package.json, so a plugin folder
 * without its own would be packed as that ancestor project: its files listed,
 * then staged from the wrong folder, or that project's build script run
 * (#1093). `validate` and `build` both refuse before npm runs, in these words.
 */
export const requireOwnPackageJson = async (projectDir: string): Promise<void> => {
  if (!(await isFile(join(projectDir, 'package.json')))) {
    throw new ToolkitError(
      'NPM_PACK_FAILED',
      undefined,
      `There is no package.json in ${quoteUntrustedText(projectDir)}; a plugin's folder needs its own.`,
    );
  }
};

const listPackedFiles = async (projectDir: string): Promise<string[]> => {
  await requireOwnPackageJson(projectDir);

  let stdout: string;

  try {
    stdout = await runNpm(PACK_ARGS, projectDir);
  } catch (error) {
    if (error instanceof NpmCommandError) {
      throw npmPackFailure(error);
    }

    throw error;
  }

  const paths = packedPaths(stdout);

  if (paths === undefined) {
    throw new ToolkitError('NPM_PACK_FAILED', undefined, 'npm printed a file list in a form the build cannot read.');
  }

  return paths;
};

/** Whether `file` is there to add; a folder by that name is not a file to pack. */
const isPresent = async (projectDir: string, file: string): Promise<boolean> => {
  try {
    return !(await lstat(join(projectDir, file))).isDirectory();
  } catch {
    return false;
  }
};

/**
 * `excludeDir` as a prefix to match npm's relative paths against, or
 * undefined when it names the project folder itself (an output folder there
 * leaves only the `.tgz` rule to keep old plugin artifacts out).
 */
const excludedPrefix = (excludeDir: string | undefined): string | undefined => {
  if (excludeDir === undefined) {
    return undefined;
  }

  const normalized = posix.normalize(excludeDir).replace(/\/+$/, '');

  return normalized === '' || normalized === '.' ? undefined : `${normalized}/`;
};

const isPluginArtifactFile = (path: string): boolean => path.endsWith('.tgz') || path.endsWith('.tgz.sha256');

export interface PluginFileSelection {
  /** The files the plugin artifact holds, relative to the project, sorted. */
  readonly files: readonly string[];

  /**
   * Files npm would publish but the plugin artifact leaves out because their
   * names end in `.tgz` or `.tgz.sha256`, outside `excludeDir`, sorted. The
   * caller reports each as PLUGIN_ARTIFACT_LEFT_OUT: a file missing from a
   * plugin artifact breaks the plugin at runtime (#1093).
   */
  readonly leftOut: readonly string[];
}

/**
 * A warning for each file the selection left out because its name ends like a
 * plugin artifact or its checksum (#1093).
 */
export const leftOutWarnings = (leftOut: readonly string[]): ReportItem[] =>
  leftOut.map((entry) => ({
    at: entry,
    code: 'PLUGIN_ARTIFACT_LEFT_OUT',
    message: message('PLUGIN_ARTIFACT_LEFT_OUT', { entry }),
  }));

/**
 * The project's files a plugin artifact holds, as paths relative to
 * `projectDir` (#1093): what `npm pack` would publish, plus `manifest.json`
 * and `package-lock.json` where they exist, less anything under `excludeDir`
 * and any `.tgz` or `.tgz.sha256` file. An older plugin artifact must never
 * be packed again, so those are dropped everywhere; the ones outside
 * `excludeDir` are named in `leftOut`. npm's failure is reported as
 * NPM_PACK_FAILED, with npm's own words.
 */
export const selectPluginFiles = async (
  projectDir: string,
  options: SelectPluginFilesOptions = {},
): Promise<PluginFileSelection> => {
  const selected = new Set(await listPackedFiles(projectDir));

  for (const file of ALWAYS_SELECTED) {
    if (await isPresent(projectDir, file)) {
      selected.add(file);
    }
  }

  const prefix = excludedPrefix(options.excludeDir);
  const files: string[] = [];
  const leftOut: string[] = [];

  for (const path of selected) {
    if (prefix !== undefined && path.startsWith(prefix)) {
      continue;
    }

    (isPluginArtifactFile(path) ? leftOut : files).push(path);
  }

  return { files: files.sort(compareBytewise), leftOut: leftOut.sort(compareBytewise) };
};
