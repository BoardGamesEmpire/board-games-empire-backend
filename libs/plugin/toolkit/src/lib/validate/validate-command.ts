import { extractPluginArchive, PluginArchiveRefusedError } from '@boardgamesempire/plugin-analysis';
import {
  isPlainJsonObject,
  PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES,
  PLUGIN_SLUG_PATTERN,
} from '@boardgamesempire/plugin-manifest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { valid } from 'semver';
import type { ValidateOptions } from '../cli.js';
import { message } from '../messages.js';
import type { ReportItem, ValidationReport } from '../report.js';
import { checkArtifactEntries, listArtifactEntries } from '../stage/artifact-entries.js';
import { selectPluginFiles } from '../stage/select-plugin-files.js';
import { stagePluginFiles } from '../stage/stage-plugin-files.js';
import { validatePluginTree } from './validate-plugin-tree.js';

/**
 * The folder `build` writes plugin artifacts into by default, left out of the
 * selection so a `validate` after a `build` doesn't warn about them (#1093).
 */
const DEFAULT_BUILD_OUTPUT = 'bge-artifacts';

/** npm's own top-level folder name, used when the plugin manifest gives no slug and version. */
const FALLBACK_TOP_LEVEL = 'package';

/** Each command's temporary folder, under the OS temp folder and always removed. */
const withTempDir = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'bge-plugin-'));

  try {
    return await use(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

/**
 * `<slug>-<version>`, the top-level folder a plugin artifact of this plugin
 * holds. Only a well-formed slug and version name it: anything else falls back
 * to `package`, so a bad slug or version is reported once, by the validator,
 * and never as an archive-rule error the plugin author didn't write (#1093).
 */
const topLevelFor = async (rootDir: string): Promise<string> => {
  try {
    const raw: unknown = JSON.parse(await readFile(join(rootDir, 'manifest.json'), 'utf8'));

    if (
      isPlainJsonObject(raw) &&
      typeof raw['slug'] === 'string' &&
      PLUGIN_SLUG_PATTERN.test(raw['slug']) &&
      typeof raw['version'] === 'string' &&
      valid(raw['version']) !== null
    ) {
      return `${raw['slug']}-${raw['version']}`;
    }
  } catch {
    // Unreadable here is reported by validatePluginTree as MANIFEST_UNREADABLE.
  }

  return FALLBACK_TOP_LEVEL;
};

const merge = (first: ValidationReport, second: ValidationReport): ValidationReport => ({
  errors: [...first.errors, ...second.errors],
  notes: [...first.notes, ...second.notes],
  warnings: [...first.warnings, ...second.warnings],
});

/**
 * A plugin folder is judged by the files its plugin artifact would hold
 * (#1093): npm's selection, copied into a temporary folder, so build tooling
 * and tests the plugin artifact leaves out aren't screened. The copy goes
 * through the server's archive rules as the entries `build` would write, then
 * through the server's checks.
 */
const validateFolder = async (projectDir: string, options: ValidateOptions): Promise<ValidationReport> => {
  const { files, leftOut } = await selectPluginFiles(projectDir, { excludeDir: DEFAULT_BUILD_OUTPUT });

  return withTempDir(async (stageDir) => {
    await stagePluginFiles(projectDir, files, stageDir);

    const archive: ValidationReport = {
      errors: checkArtifactEntries(await listArtifactEntries(stageDir, await topLevelFor(stageDir))),
      notes: [],
      warnings: leftOut.map((entry): ReportItem => ({
        at: entry,
        code: 'PLUGIN_ARTIFACT_LEFT_OUT',
        message: message('PLUGIN_ARTIFACT_LEFT_OUT', { entry }),
      })),
    };

    return merge(archive, await validatePluginTree(stageDir, options));
  });
};

/**
 * A plugin artifact is unpacked by the server's own extractor, which applies
 * the archive rules as it goes, so a refusal here is the server's refusal
 * (#1093). The extractor stops at the first one, as the server does.
 */
const validateArtifact = (artifactPath: string, options: ValidateOptions): Promise<ValidationReport> =>
  withTempDir(async (workDir) => {
    const intoDir = join(workDir, 'plugin');

    try {
      await extractPluginArchive(artifactPath, intoDir);
    } catch (error) {
      if (!(error instanceof PluginArchiveRefusedError)) {
        throw error;
      }

      const { entry, rule } = error;
      const item: ReportItem =
        entry === undefined
          ? { code: rule, message: message(rule) }
          : { at: entry, code: rule, message: message(rule, { entry }) };

      return { errors: [item], notes: [], warnings: [] };
    }

    return validatePluginTree(intoDir, options);
  });

const usage = (target: string): ValidationReport => ({
  errors: [
    {
      at: target,
      code: 'USAGE',
      message: `${message('USAGE')} validate needs a plugin folder or a plugin artifact (a .tgz file), and this is neither.`,
    },
  ],
  notes: [],
  warnings: [],
});

/**
 * `bge-plugin validate` (#1093): checks a plugin folder, or a plugin artifact
 * ending in `.tgz`, as a server checks a plugin at install, and reports every
 * refusal, warning and unchecked area. Any other path is a usage error.
 */
export const runValidate = async (target: string, options: ValidateOptions): Promise<ValidationReport> => {
  const found = await stat(target).catch(() => undefined);

  if (found?.isDirectory() === true) {
    return validateFolder(target, options);
  }

  if (found?.isFile() === true && target.endsWith('.tgz')) {
    // A server refuses a plugin artifact over the cap where it arrives, before
    // reading a byte; the extractor caps only what it unpacks (#1093).
    if (found.size > PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES) {
      return {
        errors: [{ code: 'ARTIFACT_TOO_LARGE', message: message('ARTIFACT_TOO_LARGE') }],
        notes: [],
        warnings: [],
      };
    }

    return validateArtifact(target, options);
  }

  return usage(target);
};
