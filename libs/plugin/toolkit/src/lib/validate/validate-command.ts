import { extractPluginArchive, PluginArchiveRefusedError } from '@boardgamesempire/plugin-analysis';
import { PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES } from '@boardgamesempire/plugin-manifest';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingPathError } from '../fs/is-file.js';
import { withTempDir } from '../fs/with-temp-dir.js';
import { message } from '../messages.js';
import type { ValidateOptions } from '../options.js';
import { DEFAULT_OUT_DIR } from '../options.js';
import type { ValidationReport } from '../report.js';
import { reportWithError } from '../report.js';
import { archiveRefusalItem } from '../stage/artifact-entries.js';
import { selectPluginFiles } from '../stage/select-plugin-files.js';
import { stagePluginFiles } from '../stage/stage-plugin-files.js';
import { checkStagedPlugin } from './check-staged-plugin.js';
import { validatePluginTree } from './validate-plugin-tree.js';

/**
 * A plugin folder is judged by the files its plugin artifact would hold
 * (#1093): npm's selection, as a `build` into the default output folder would
 * make it, copied into a temporary folder, so build tooling and tests the
 * plugin artifact leaves out aren't screened. The copy goes through the
 * server's archive rules as the entries `build` would write, then through the
 * server's checks.
 */
const validateFolder = async (projectDir: string, options: ValidateOptions): Promise<ValidationReport> => {
  const { files, leftOut } = await selectPluginFiles(projectDir, { excludeDir: DEFAULT_OUT_DIR });

  return withTempDir(async (stageDir) => {
    await stagePluginFiles(projectDir, files, stageDir);

    return (await checkStagedPlugin(stageDir, leftOut, options)).report;
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

      return reportWithError(archiveRefusalItem(error));
    }

    return validatePluginTree(intoDir, options);
  });

const usage = (target: string, detail: string): ValidationReport =>
  reportWithError({ at: target, code: 'USAGE', message: `${message('USAGE')} ${detail}` });

/**
 * What is at `target`, or undefined when nothing is. Any other failure to
 * look (a folder it may not read, say) is thrown with its own words (#1093).
 */
const statOrMissing = async (target: string): Promise<Stats | undefined> => {
  try {
    return await stat(target);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
};

/**
 * `bge-plugin validate` (#1093): checks a plugin folder, or a plugin artifact
 * ending in `.tgz`, as a server checks a plugin at install, and reports every
 * refusal, warning and unchecked area. Any other path is a usage error.
 */
export const runValidate = async (target: string, options: ValidateOptions): Promise<ValidationReport> => {
  const found = await statOrMissing(target);

  if (found === undefined) {
    return usage(target, 'There is no such file or folder.');
  }

  if (found.isDirectory()) {
    return validateFolder(target, options);
  }

  if (found.isFile() && target.endsWith('.tgz')) {
    // A server refuses a plugin artifact over the cap where it arrives, before
    // reading a byte; the extractor caps only what it unpacks (#1093).
    if (found.size > PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES) {
      return reportWithError({ code: 'ARTIFACT_TOO_LARGE', message: message('ARTIFACT_TOO_LARGE') });
    }

    return validateArtifact(target, options);
  }

  return usage(target, 'validate needs a plugin folder or a plugin artifact (a .tgz file), and this is neither.');
};
