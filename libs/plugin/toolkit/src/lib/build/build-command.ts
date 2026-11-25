import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isFile } from '../fs/is-file.js';
import { withTempDir } from '../fs/with-temp-dir.js';
import { describeNpmFailure, NpmCommandError, runNpm } from '../npm/run-npm.js';
import type { BuildOptions } from '../options.js';
import type { ArtifactOutcome, BuildOutcome } from '../report.js';
import type { ArtifactEntry } from '../stage/artifact-entries.js';
import type { SelectPluginFilesOptions } from '../stage/select-plugin-files.js';
import { leftOutWarnings, requireOwnPackageJson, selectPluginFiles } from '../stage/select-plugin-files.js';
import { shrinkwrapErrors } from '../stage/shrinkwrap.js';
import { stagePluginFiles } from '../stage/stage-plugin-files.js';
import { urlCredentialErrors } from '../stage/url-credentials.js';
import { ToolkitError } from '../toolkit.errors.js';
import { checkStagedPlugin } from '../validate/check-staged-plugin.js';
import { installDependencies } from './install-dependencies.js';
import { LOCKFILE, readLockfile } from './lockfile.js';
import { packArtifact } from './pack-artifact.js';
import { renderSourcesMarkdown } from './sources-markdown.js';

/** The plugin's own build, if it has one (#1093). */
const BUILD_ARGS = ['run', 'build', '--if-present'] as const;

const SOURCES_FILE = 'SOURCES.md';

/** The latest time a tar header holds here: tar-stream writes the mtime through a 32-bit integer. */
const MAX_MTIME_SECONDS = 2 ** 31 - 1;

/**
 * The output folder relative to the project, with `/` separators, so an
 * earlier build's plugin artifacts there are never packed into the next
 * (#1093). An output folder outside the project needs no exclusion.
 */
const excludeOptionFor = (projectDir: string, outDir: string): SelectPluginFilesOptions => {
  const fromProject = relative(projectDir, outDir);

  if (isAbsolute(fromProject) || fromProject === '..' || fromProject.startsWith(`..${sep}`)) {
    return {};
  }

  return { excludeDir: fromProject.split(sep).join('/') };
};

/**
 * What the build needs before anything runs (#1093): the plugin's own
 * package.json, and a package-lock.json in a form the build reads, so a
 * lockfile npm ci or SOURCES.md would refuse stops the build before the
 * plugin's own build script has run.
 */
const requireBuildInputs = async (projectDir: string): Promise<void> => {
  await requireOwnPackageJson(projectDir);

  if (!(await isFile(join(projectDir, LOCKFILE)))) {
    throw new ToolkitError('LOCKFILE_MISSING');
  }

  await readLockfile(projectDir);
};

/** Runs the plugin's own `build` script in its folder, when it has one. */
const runPluginBuild = async (projectDir: string): Promise<void> => {
  try {
    await runNpm(BUILD_ARGS, projectDir);
  } catch (error) {
    if (!(error instanceof NpmCommandError)) {
      throw error;
    }

    // A compiler often prints its errors on stdout, which the report leaves out.
    throw new ToolkitError(
      'PLUGIN_BUILD_FAILED',
      undefined,
      `Run npm run build in the plugin's folder to see all of its output. ${describeNpmFailure(error)}`,
    );
  }
};

/** Writes SOURCES.md into the temporary copy, listing what npm installed there. */
const writeSourcesMarkdown = async (stageDir: string): Promise<void> => {
  const markdown = renderSourcesMarkdown(await readLockfile(stageDir), (lockPath) =>
    existsSync(join(stageDir, lockPath)),
  );

  await writeFile(join(stageDir, SOURCES_FILE), markdown);
};

/** `SOURCE_DATE_EPOCH` in whole seconds when it holds one a tar header can carry, else 0. */
const sourceDateEpoch = (): number => {
  const seconds = Number(process.env['SOURCE_DATE_EPOCH']);

  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_MTIME_SECONDS ? seconds : 0;
};

/**
 * Writes the plugin artifact `<name>.tgz` and its `sha256sum` checksum file
 * into `outDir`. An earlier checksum file of that name is removed just before
 * the new plugin artifact takes its name, so a checksum write that fails
 * never leaves a stale checksum beside it (#1093).
 */
const writeArtifact = async (
  entries: readonly ArtifactEntry[],
  name: string,
  outDir: string,
): Promise<ArtifactOutcome> => {
  const fileName = `${name}.tgz`;
  const path = join(outDir, fileName);
  const sidecarPath = `${path}.sha256`;

  await mkdir(outDir, { recursive: true });

  const { sha256 } = await packArtifact(entries, path, sourceDateEpoch(), {
    beforeRename: () => rm(sidecarPath, { force: true }),
  });

  // Two spaces: `sha256sum -c` reads the file name after them.
  await writeFile(sidecarPath, `${sha256}  ${fileName}\n`);

  return { path, sha256, sidecarPath };
};

/**
 * `bge-plugin build` (#1093): builds the plugin in `projectDir` and writes its
 * plugin artifact, `<slug>-<version>.tgz`, and a checksum file `sha256sum -c`
 * reads into `outDir`.
 *
 * The plugin's own build runs first. Then npm's selection of its files is
 * copied into a temporary folder; a URL with credentials in its package.json
 * or package-lock.json, or an npm-shrinkwrap.json, stops the build there,
 * before npm reads any of them. Its
 * production dependencies are installed there as package-lock.json records
 * them, and SOURCES.md lists them. That copy goes through the server's
 * archive rules and the same checks `validate` runs. Any error returns the
 * report with no plugin artifact, and nothing is written to `outDir`. A
 * plugin that cannot be built at all (no package-lock.json, a failing build
 * script, an install npm refuses) is a ToolkitError.
 *
 * The same files give the same bytes: entries are sorted and carry
 * `SOURCE_DATE_EPOCH` (or 0) as their time, so a plugin artifact can be
 * rebuilt and checked against its checksum.
 */
export const runBuild = async (projectDir: string, options: BuildOptions): Promise<BuildOutcome> => {
  await requireBuildInputs(projectDir);
  await runPluginBuild(projectDir);

  const { files, leftOut } = await selectPluginFiles(projectDir, excludeOptionFor(projectDir, options.outDir));

  return withTempDir(async (workDir) => {
    // In a folder of its own, so a relative path out of it leads nowhere.
    const stageDir = join(workDir, 'plugin');

    await mkdir(stageDir);
    await stagePluginFiles(projectDir, files, stageDir);

    // Before npm ci, which would fetch with a password a URL holds, or fail
    // on a stale one before this refusal is reported, and would install from
    // an npm-shrinkwrap.json rather than package-lock.json (#1093).
    const metadataErrors = [...(await shrinkwrapErrors(stageDir)), ...(await urlCredentialErrors(stageDir))];

    if (metadataErrors.length > 0) {
      return { report: { errors: metadataErrors, notes: [], warnings: leftOutWarnings(leftOut) } };
    }

    await installDependencies(stageDir);
    await writeSourcesMarkdown(stageDir);

    const { entries, name, report } = await checkStagedPlugin(stageDir, leftOut, options);

    if (report.errors.length > 0) {
      return { report };
    }

    try {
      return { artifact: await writeArtifact(entries, name, options.outDir), report };
    } catch (error) {
      // Too large for a server: report it beside everything else the checks found.
      if (!(error instanceof ToolkitError)) {
        throw error;
      }

      return { report: { ...report, errors: [error.toReportItem()] } };
    }
  });
};
