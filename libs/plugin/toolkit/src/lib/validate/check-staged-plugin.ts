import { message } from '../messages.js';
import type { ValidateOptions } from '../options.js';
import type { ReportItem, ValidationReport } from '../report.js';
import { mergeReports } from '../report.js';
import type { ArtifactEntry } from '../stage/artifact-entries.js';
import { checkArtifactEntries, listArtifactEntries } from '../stage/artifact-entries.js';
import { FALLBACK_ARTIFACT_NAME, isArtifactNameTooLong, readArtifactName } from '../stage/artifact-name.js';
import { leftOutWarnings } from '../stage/select-plugin-files.js';
import { shrinkwrapErrors } from '../stage/shrinkwrap.js';
import { urlCredentialErrors } from '../stage/url-credentials.js';
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
 * selection dropped) become warnings. Three errors the server has no rule
 * for come from the build itself: a package.json or package-lock.json holding
 * a URL with credentials in it (the plugin artifact would ship the token), an
 * npm-shrinkwrap.json (npm ci would install from it, not package-lock.json),
 * and a slug and version too long to name the plugin artifact's files. A name
 * too long is reported once, and the entries are listed under `package`, so
 * the archive rules don't report it again on every entry. `validate` and
 * `build` both judge a plugin folder this way, so they reach the same report.
 */
export const checkStagedPlugin = async (
  stageDir: string,
  leftOut: readonly string[],
  options: ValidateOptions,
): Promise<StagedPluginCheck> => {
  const manifestName = await readArtifactName(stageDir);
  const nameTooLong = isArtifactNameTooLong(manifestName);
  const name = nameTooLong ? FALLBACK_ARTIFACT_NAME : manifestName;
  const nameErrors: ReportItem[] = nameTooLong
    ? [{ at: 'manifest.json', code: 'ARTIFACT_NAME_TOO_LONG', message: message('ARTIFACT_NAME_TOO_LONG') }]
    : [];
  const entries = await listArtifactEntries(stageDir, name);
  const archiveErrors = checkArtifactEntries(entries);
  const missingManifestReported = archiveErrors.some(
    (item) => item.code === 'required-file' && item.at === 'manifest.json',
  );

  const report = mergeReports(
    {
      errors: [
        ...archiveErrors,
        ...nameErrors,
        ...(await shrinkwrapErrors(stageDir)),
        ...(await urlCredentialErrors(stageDir)),
      ],
      notes: [],
      warnings: leftOutWarnings(leftOut),
    },
    await validatePluginTree(stageDir, options, { missingManifestReported }),
  );

  return { entries, name, report };
};
