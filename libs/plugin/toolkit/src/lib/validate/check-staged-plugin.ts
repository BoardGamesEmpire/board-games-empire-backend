import type { ValidateOptions } from '../options.js';
import type { ValidationReport } from '../report.js';
import { mergeReports } from '../report.js';
import type { ArtifactEntry } from '../stage/artifact-entries.js';
import { checkArtifactEntries, listArtifactEntries } from '../stage/artifact-entries.js';
import { readArtifactName } from '../stage/artifact-name.js';
import { leftOutWarnings } from '../stage/select-plugin-files.js';
import { validatePluginTree } from './validate-plugin-tree.js';

export interface StagedPluginCheck {
  /** The entries a plugin artifact of the folder holds, under `name`. */
  readonly entries: readonly ArtifactEntry[];

  /** `<slug>-<version>`, or `package`: the plugin artifact's top-level folder and file name. */
  readonly name: string;

  readonly report: ValidationReport;
}

/**
 * Judges a temporary copy of a plugin as the plugin artifact it would become
 * (#1093): its entries go through the server's archive rules, then the folder
 * through the checks a server runs at install. `leftOut` (the files the
 * selection dropped) become warnings. `validate` and `build` both judge a
 * plugin folder this way, so they reach the same report.
 */
export const checkStagedPlugin = async (
  stageDir: string,
  leftOut: readonly string[],
  options: ValidateOptions,
): Promise<StagedPluginCheck> => {
  const name = await readArtifactName(stageDir);
  const entries = await listArtifactEntries(stageDir, name);
  const archiveErrors = checkArtifactEntries(entries);
  const missingManifestReported = archiveErrors.some(
    (item) => item.code === 'required-file' && item.at === 'manifest.json',
  );

  const report = mergeReports(
    { errors: archiveErrors, notes: [], warnings: leftOutWarnings(leftOut) },
    await validatePluginTree(stageDir, options, { missingManifestReported }),
  );

  return { entries, name, report };
};
