import { quoteUntrustedText } from '@boardgamesempire/plugin-analysis';
import { isPlainJsonObject, PLUGIN_SLUG_PATTERN } from '@boardgamesempire/plugin-manifest';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { valid } from 'semver';
import type { BuildOptions, BuildOutcome } from '../cli.js';
import { message } from '../messages.js';
import { NpmCommandError, runNpm } from '../npm/run-npm.js';
import type { ArtifactOutcome, ReportItem, ValidationReport } from '../report.js';
import type { ArtifactEntry } from '../stage/artifact-entries.js';
import { checkArtifactEntries, listArtifactEntries } from '../stage/artifact-entries.js';
import type { SelectPluginFilesOptions } from '../stage/select-plugin-files.js';
import { selectPluginFiles } from '../stage/select-plugin-files.js';
import { stagePluginFiles } from '../stage/stage-plugin-files.js';
import { ToolkitError } from '../toolkit.errors.js';
import { validatePluginTree } from '../validate/validate-plugin-tree.js';
import { packArtifact } from './pack-artifact.js';
import { renderSourcesMarkdown } from './sources-markdown.js';

/** The plugin's own build, if it has one (#1093). */
const BUILD_ARGS = ['run', 'build', '--if-present'] as const;

/**
 * Installs exactly what package-lock.json records, without development
 * dependencies (#1093). `--ignore-scripts`: no dependency's install script
 * runs on the plugin author's machine. `--install-links`: a `file:`
 * dependency is copied in, not linked. `--no-bin-links`: no
 * `node_modules/.bin`, whose entries are always links.
 */
const INSTALL_ARGS = ['ci', '--omit=dev', '--ignore-scripts', '--install-links', '--no-bin-links'] as const;

const LOCKFILE = 'package-lock.json';
const MANIFEST_FILE = 'manifest.json';
const PACKAGE_JSON = 'package.json';
const SOURCES_FILE = 'SOURCES.md';

/** npm's own top-level folder name, used when the plugin manifest gives no usable slug and version. */
const FALLBACK_TOP_LEVEL = 'package';

/** How much of npm's output a report quotes: the end, where npm says what failed. */
const NPM_OUTPUT_LINES = 20;

/** The latest time a tar header holds here: tar-stream writes the mtime through a 32-bit integer. */
const MAX_MTIME_SECONDS = 2 ** 31 - 1;

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const;

/** The build's temporary folder, under the OS temp folder and always removed. */
const withTempDir = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'bge-plugin-'));

  try {
    return await use(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
};

/** The end of what npm printed, or Node's account when npm never ran. */
const npmSaid = (error: NpmCommandError): string => {
  const lines = error.stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  const end = lines.slice(-NPM_OUTPUT_LINES).join('\n');

  if (error.exitCode === null) {
    return `npm could not be run: ${end}`;
  }

  return lines.length > NPM_OUTPUT_LINES ? `npm's last ${NPM_OUTPUT_LINES} lines:\n${end}` : `npm said:\n${end}`;
};

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
 * A dependency spec npm resolves from the plugin's folder: `file:` with a
 * relative path, or a bare `./` or `../` path. A home-relative `~/` path is
 * left out, since it resolves the same from anywhere.
 */
const isRelativePathSpec = (spec: string): boolean => {
  if (spec.startsWith('file:')) {
    const path = spec.slice('file:'.length);

    return !isAbsolute(path) && !path.startsWith('~');
  }

  return /^\.\.?(?:[\\/]|$)/.test(spec);
};

/** The dependencies the staged package.json names by a relative path, by name. */
const relativePathDependencies = async (stageDir: string): Promise<string[]> => {
  let packageJson: unknown;

  try {
    packageJson = JSON.parse(await readFile(join(stageDir, PACKAGE_JSON), 'utf8'));
  } catch {
    return [];
  }

  if (!isPlainJsonObject(packageJson)) {
    return [];
  }

  const names: string[] = [];

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];

    if (!isPlainJsonObject(dependencies)) {
      continue;
    }

    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === 'string' && isRelativePathSpec(spec)) {
        names.push(name);
      }
    }
  }

  return names;
};

/**
 * Refuses a folder without its own package.json before npm runs in it: npm
 * would walk up to the nearest ancestor that has one and run that project's
 * build script. The same refusal, word for word, as `validate` gives (#1093).
 */
const requireOwnPackageJson = async (projectDir: string): Promise<void> => {
  if (!(await isFile(join(projectDir, PACKAGE_JSON)))) {
    throw new ToolkitError(
      'NPM_PACK_FAILED',
      undefined,
      `There is no package.json in ${quoteUntrustedText(projectDir)}; a plugin's folder needs its own.`,
    );
  }
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
      `Run npm run build in the plugin's folder to see all of its output. ${npmSaid(error)}`,
    );
  }
};

/**
 * Installs the plugin's production dependencies into the staged copy, as
 * package-lock.json records them (#1093). The copy sits in a temporary
 * folder, so a dependency named by a relative path no longer resolves: the
 * report says so, since npm's own words for it don't.
 */
const installDependencies = async (stageDir: string): Promise<void> => {
  try {
    await runNpm(INSTALL_ARGS, stageDir);
  } catch (error) {
    if (!(error instanceof NpmCommandError)) {
      throw error;
    }

    const relativeNames = await relativePathDependencies(stageDir);
    const hint =
      relativeNames.length === 0
        ? ''
        : `package.json names ${relativeNames.map((name) => quoteUntrustedText(name)).join(', ')} by a relative file: path, which the build cannot install: it installs from a copy of the plugin in a temporary folder, where that path leads nowhere. Name the dependency by an absolute path to a .tgz made with npm pack, then run npm install again. `;

    throw new ToolkitError('DEPENDENCY_INSTALL_FAILED', undefined, `${hint}${npmSaid(error)}`);
  }
};

/** Writes SOURCES.md into the staged copy, listing what npm installed there. */
const writeSourcesMarkdown = async (stageDir: string): Promise<void> => {
  const lockfile: unknown = JSON.parse(await readFile(join(stageDir, LOCKFILE), 'utf8'));
  const markdown = renderSourcesMarkdown(lockfile, (lockPath) => existsSync(join(stageDir, lockPath)));

  await writeFile(join(stageDir, SOURCES_FILE), markdown);
};

/**
 * `<slug>-<version>`, the plugin artifact's top-level folder and file name,
 * from a slug the server accepts and the version as semver writes it (so
 * `v1.2.0` gives `1.2.0`). Anything else gives `package`, and the plugin
 * manifest's errors stop the build before a name is needed.
 */
const topLevelFor = async (stageDir: string): Promise<string> => {
  let raw: unknown;

  try {
    raw = JSON.parse(await readFile(join(stageDir, MANIFEST_FILE), 'utf8'));
  } catch {
    // validatePluginTree reports this as MANIFEST_UNREADABLE.
    return FALLBACK_TOP_LEVEL;
  }

  const slug = isPlainJsonObject(raw) ? raw['slug'] : undefined;
  const version = isPlainJsonObject(raw) && typeof raw['version'] === 'string' ? valid(raw['version']) : null;

  return typeof slug === 'string' && PLUGIN_SLUG_PATTERN.test(slug) && version !== null
    ? `${slug}-${version}`
    : FALLBACK_TOP_LEVEL;
};

/** `SOURCE_DATE_EPOCH` in whole seconds when it holds one a tar header can carry, else 0. */
const sourceDateEpoch = (): number => {
  const seconds = Number(process.env['SOURCE_DATE_EPOCH']);

  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_MTIME_SECONDS ? seconds : 0;
};

/** Writes the plugin artifact and its `sha256sum` checksum file into `outDir`. */
const writeArtifact = async (
  entries: readonly ArtifactEntry[],
  topLevel: string,
  outDir: string,
): Promise<ArtifactOutcome> => {
  const fileName = `${topLevel}.tgz`;
  const path = join(outDir, fileName);
  const sidecarPath = `${path}.sha256`;

  await mkdir(outDir, { recursive: true });

  const { sha256 } = await packArtifact(entries, path, sourceDateEpoch());

  // Two spaces: `sha256sum -c` reads the file name after them.
  await writeFile(sidecarPath, `${sha256}  ${fileName}\n`);

  return { path, sha256, sidecarPath };
};

const merge = (first: ValidationReport, second: ValidationReport): ValidationReport => ({
  errors: [...first.errors, ...second.errors],
  notes: [...first.notes, ...second.notes],
  warnings: [...first.warnings, ...second.warnings],
});

/**
 * `bge-plugin build` (#1093): builds the plugin in `projectDir` and writes its
 * plugin artifact, `<slug>-<version>.tgz`, and a checksum file `sha256sum -c`
 * reads into `outDir`.
 *
 * The plugin's own build runs first. Then npm's selection of its files is
 * copied into a temporary folder, its production dependencies are installed
 * there as package-lock.json records them, and SOURCES.md lists them. That
 * copy goes through the server's archive rules and the same checks
 * `validate` runs. Any error returns the report with no plugin artifact, and
 * nothing is written to `outDir`. A plugin that cannot be built at all (no
 * package-lock.json, a failing build script, an install npm refuses) is a
 * ToolkitError.
 *
 * The same files give the same bytes: entries are sorted and carry
 * `SOURCE_DATE_EPOCH` (or 0) as their time, so a plugin artifact can be
 * rebuilt and checked against its checksum.
 */
export const runBuild = async (projectDir: string, options: BuildOptions): Promise<BuildOutcome> => {
  await requireOwnPackageJson(projectDir);

  if (!(await isFile(join(projectDir, LOCKFILE)))) {
    throw new ToolkitError('LOCKFILE_MISSING');
  }

  await runPluginBuild(projectDir);

  const { files, leftOut } = await selectPluginFiles(projectDir, excludeOptionFor(projectDir, options.outDir));
  const leftOutWarnings = leftOut.map((entry): ReportItem => ({
    at: entry,
    code: 'PLUGIN_ARTIFACT_LEFT_OUT',
    message: message('PLUGIN_ARTIFACT_LEFT_OUT', { entry }),
  }));

  return withTempDir(async (workDir) => {
    // In a folder of its own, so a relative path out of it leads nowhere.
    const stageDir = join(workDir, 'plugin');

    await mkdir(stageDir);
    await stagePluginFiles(projectDir, files, stageDir);
    await installDependencies(stageDir);
    await writeSourcesMarkdown(stageDir);

    const topLevel = await topLevelFor(stageDir);
    const entries = await listArtifactEntries(stageDir, topLevel);
    const report = merge(
      { errors: checkArtifactEntries(entries), notes: [], warnings: leftOutWarnings },
      await validatePluginTree(stageDir, options),
    );

    if (report.errors.length > 0) {
      return { report };
    }

    try {
      return { artifact: await writeArtifact(entries, topLevel, options.outDir), report };
    } catch (error) {
      // Too large for a server: report it beside everything else the checks found.
      if (!(error instanceof ToolkitError)) {
        throw error;
      }

      return { report: { ...report, errors: [error.toReportItem()] } };
    }
  });
};
