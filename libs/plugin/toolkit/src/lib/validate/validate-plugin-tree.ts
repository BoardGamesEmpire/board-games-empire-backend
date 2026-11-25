import type { StaticAnalysisFinding, StaticAnalysisFindingKind } from '@boardgamesempire/plugin-analysis';
import { isGatingFinding, PluginStaticAnalyzer } from '@boardgamesempire/plugin-analysis';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import {
  collectForbiddenPermissionViolations,
  compareUnitConsentRequirements,
  isPlainJsonObject,
  PluginManifestValidationError,
  validatePluginManifest,
} from '@boardgamesempire/plugin-manifest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingPathError } from '../fs/is-file.js';
import { CONSENT_COMPARISON_SKIPPED_REASONS, message } from '../messages.js';
import type { ValidateOptions } from '../options.js';
import type { ReportItem, ValidationReport } from '../report.js';
import { reportWithError } from '../report.js';
import { ToolkitError } from '../toolkit.errors.js';
import { readAgainstManifest } from './read-against-manifest.js';

const MANIFEST_FILE = 'manifest.json';
const PACKAGE_JSON_FILE = 'package.json';

type RawManifest =
  | { readonly kind: 'missing' }
  | { readonly kind: 'read'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'unreadable' };

/** The plugin manifest as a plain JSON object, or why there is none: no file, or one that is not JSON or not an object. */
const readRawManifest = async (rootDir: string): Promise<RawManifest> => {
  let text: string;

  try {
    text = await readFile(join(rootDir, MANIFEST_FILE), 'utf8');
  } catch (error) {
    return { kind: isMissingPathError(error) ? 'missing' : 'unreadable' };
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return isPlainJsonObject(parsed) ? { kind: 'read', raw: parsed } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
};

/**
 * Where a forbidden permission is written in the plugin manifest: its
 * `declares` entry for one the plugin declares, else its `checks` entry. Both
 * lists keep the plugin manifest's order (#1093).
 */
const permissionPath = (validated: PluginManifestValidationResult, permissionSlug: string): string | undefined => {
  const declared = validated.declaredPermissions.findIndex((entry) => entry.canonicalSlug === permissionSlug);

  if (declared !== -1) {
    return `permissions.declares[${declared}]`;
  }

  const checked = validated.permissionChecks.findIndex((check) => check.canonicalSlug === permissionSlug);

  return checked === -1 ? undefined : `permissions.checks[${checked}]`;
};

/** A finding as a report line at its file, under its own kind or as an accepted import. */
const findingItem = (
  finding: StaticAnalysisFinding,
  code: StaticAnalysisFindingKind | 'FORBIDDEN_IMPORT_ACCEPTED',
): ReportItem => ({
  at: finding.file,
  code,
  message: message(code, finding.specifier === null ? {} : { specifier: finding.specifier }),
});

/** Every skipped check is stated (#1093): the consent comparison, with why it did not run. */
const comparisonSkipped = (reason: string): ReportItem => ({
  code: 'CONSENT_COMPARISON_SKIPPED',
  message: `${message('CONSENT_COMPARISON_SKIPPED')} ${reason}`,
});

export interface ValidatePluginTreeContext {
  /**
   * The archive rules already reported `manifest.json` as a missing required
   * file, so a missing one is not reported a second time as
   * MANIFEST_UNREADABLE (#1093). A manifest.json that is there but not a JSON
   * object is still reported.
   */
  readonly missingManifestReported?: boolean;
}

/**
 * Checks an unpacked plugin the way a server checks one at install (#1093),
 * by running the server's own code on it: the plugin manifest validator, the
 * forbidden-permission rule and the import scan, then, when `--against` names
 * an earlier version of the plugin, the consent comparison a server makes on
 * an update. Manifest issues and gating forbidden imports are errors, unless
 * the plugin author accepted the import; advisory findings and the
 * validator's warnings are warnings; notes say what was not checked.
 */
export const validatePluginTree = async (
  rootDir: string,
  options: ValidateOptions,
  { missingManifestReported = false }: ValidatePluginTreeContext = {},
): Promise<ValidationReport> => {
  const manifest = await readRawManifest(rootDir);

  if (manifest.kind === 'missing' && missingManifestReported) {
    return { errors: [], notes: [], warnings: [] };
  }

  if (manifest.kind !== 'read') {
    return reportWithError({ at: MANIFEST_FILE, code: 'MANIFEST_UNREADABLE', message: message('MANIFEST_UNREADABLE') });
  }

  const { raw } = manifest;

  const errors: ReportItem[] = [];
  const warnings: ReportItem[] = [];
  const notes: ReportItem[] = [];
  let validated: PluginManifestValidationResult | undefined;

  try {
    validated = validatePluginManifest(raw, { bgeVersion: options.bgeVersion, defaultLocale: options.defaultLocale });
  } catch (error) {
    if (!(error instanceof PluginManifestValidationError)) {
      throw error;
    }

    errors.push(...error.issues.map((issue) => ({ at: issue.path, code: issue.code, message: issue.message })));
  }

  if (validated !== undefined) {
    warnings.push(
      ...validated.warnings.map((warning) => ({ at: warning.path, code: warning.code, message: warning.message })),
    );

    for (const violation of collectForbiddenPermissionViolations(validated)) {
      const at = permissionPath(validated, violation.permissionSlug);
      const text = message('PLUGIN_PERMISSION_FORBIDDEN', { permission: violation.permissionSlug });

      errors.push(
        at === undefined
          ? { code: 'PLUGIN_PERMISSION_FORBIDDEN', message: text }
          : { at, code: 'PLUGIN_PERMISSION_FORBIDDEN', message: text },
      );
    }
  }

  const slug = typeof raw['slug'] === 'string' ? raw['slug'] : 'plugin';
  const scan = await new PluginStaticAnalyzer().analyze(
    { packageJsonPath: join(rootDir, PACKAGE_JSON_FILE), rootDir, slug },
    { deepScan: false },
  );
  const found = new Set<string>();

  // Keyed on the specifier, as a server admin's acceptance is: `axios` from
  // nine files is one decision (#1093).
  for (const finding of scan.findings) {
    if (!isGatingFinding(finding)) {
      warnings.push(findingItem(finding, finding.kind));
    } else if (finding.specifier !== null && options.acceptImports.includes(finding.specifier)) {
      found.add(finding.specifier);
      notes.push(findingItem(finding, 'FORBIDDEN_IMPORT_ACCEPTED'));
    } else {
      errors.push(findingItem(finding, finding.kind));
    }
  }

  for (const specifier of new Set(options.acceptImports)) {
    if (!found.has(specifier)) {
      warnings.push({
        code: 'ACCEPTED_IMPORT_NOT_FOUND',
        message: message('ACCEPTED_IMPORT_NOT_FOUND', { specifier }),
      });
    }
  }

  if (scan.truncated) {
    notes.push({ code: 'SCAN_REPORT_TRUNCATED', message: message('SCAN_REPORT_TRUNCATED') });
  }

  if (options.against === undefined) {
    notes.push(comparisonSkipped(CONSENT_COMPARISON_SKIPPED_REASONS.noAgainst));
  } else {
    try {
      // Read even when there is nothing to compare it with, so an unreadable
      // earlier version is reported in the same run.
      const previous = await readAgainstManifest(options.against, options);

      if (previous.kind === 'invalid') {
        // A warning, not a note: the plugin author asked for the comparison.
        warnings.push({ at: options.against, ...comparisonSkipped(previous.reason) });
      } else if (validated === undefined) {
        notes.push(comparisonSkipped(CONSENT_COMPARISON_SKIPPED_REASONS.invalidManifest));
      } else {
        warnings.push(
          ...compareUnitConsentRequirements(previous.manifest, validated).map((warning) => ({
            at: warning.path,
            code: warning.code,
            message: warning.message,
          })),
        );
      }
    } catch (error) {
      if (!(error instanceof ToolkitError)) {
        throw error;
      }

      errors.push(error.toReportItem());
    }
  }

  notes.push(
    { code: 'NOT_CHECKED_PERMISSION_CATALOG', message: message('NOT_CHECKED_PERMISSION_CATALOG') },
    { code: 'NOT_CHECKED_BEYOND_SCAN', message: message('NOT_CHECKED_BEYOND_SCAN') },
  );

  return { errors, notes, warnings };
};
