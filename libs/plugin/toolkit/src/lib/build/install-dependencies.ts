import { quoteUntrustedText } from '@boardgamesempire/plugin-analysis';
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { describeNpmFailure, NpmCommandError, runNpm } from '../npm/run-npm.js';
import { ToolkitError } from '../toolkit.errors.js';

/**
 * Installs exactly what package-lock.json records, without development
 * dependencies (#1093). `--ignore-scripts`: no dependency's install script
 * runs on the plugin author's machine. `--install-links`: a `file:`
 * dependency is copied in, not linked. `--no-bin-links`: no
 * `node_modules/.bin`, whose entries are always links.
 */
const INSTALL_ARGS = ['ci', '--omit=dev', '--ignore-scripts', '--install-links', '--no-bin-links'] as const;

/**
 * npm's hidden lockfile, which records each `file:` dependency's path counted
 * from the folder the install ran in: here a temporary folder, so it names the
 * plugin author's folders and makes the bytes depend on where that folder is.
 * Nothing reads it at runtime (#1093).
 */
const HIDDEN_LOCKFILE = join('node_modules', '.package-lock.json');

/**
 * A dependency map of a package.json. A field npm would refuse reads as
 * absent: this only shapes a hint after npm has already failed (#1322).
 */
const dependencyMap = z.record(z.string(), z.string()).optional().catch(undefined);

/** The plugin's package.json fields that name dependencies (#1093, #1322). */
const packageJsonDependenciesSchema = z.object({
  dependencies: dependencyMap,
  devDependencies: dependencyMap,
  optionalDependencies: dependencyMap,
  peerDependencies: dependencyMap,
});

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

/**
 * The dependencies the staged package.json names by a relative path, by name.
 * A package.json that cannot be read gives none: npm's own words already say
 * what is wrong with it.
 */
const relativePathDependencies = async (stageDir: string): Promise<string[]> => {
  let json: unknown;

  try {
    json = JSON.parse(await readFile(join(stageDir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }

  const parsed = packageJsonDependenciesSchema.safeParse(json);

  if (!parsed.success) {
    return [];
  }

  return Object.values(parsed.data).flatMap((dependencies) =>
    Object.entries(dependencies ?? {})
      .filter(([, spec]) => isRelativePathSpec(spec))
      .map(([name]) => name),
  );
};

/**
 * Installs the plugin's production dependencies into the temporary copy, as
 * package-lock.json records them, and removes npm's hidden lockfile (#1093).
 * The copy sits in a temporary folder, so a dependency named by a relative
 * path no longer resolves: the report says so, since npm's own words for it
 * don't.
 */
export const installDependencies = async (stageDir: string): Promise<void> => {
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

    throw new ToolkitError('DEPENDENCY_INSTALL_FAILED', undefined, `${hint}${describeNpmFailure(error)}`);
  }

  await rm(join(stageDir, HIDDEN_LOCKFILE), { force: true });
};
