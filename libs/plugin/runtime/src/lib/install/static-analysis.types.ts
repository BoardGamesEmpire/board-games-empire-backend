/**
 * Result shapes for install-time static analysis (#59 D-E / D-AC).
 * Types only — `plugin.events.ts` imports these for the installed event's
 * audit context, and the analyzer service imports them alongside its
 * implementation dependencies, so the shapes live in a dependency-free file.
 */

export type StaticAnalysisSeverity = 'forbidden' | 'warning';

/**
 * Which pass produced the finding. Findings from the `deep` pass
 * (`node_modules`, admin opt-in) are ADVISORY regardless of severity —
 * vendored code trips the specifier list legitimately (a dependency that
 * itself wraps `axios`), so only `default`-scope forbidden findings gate an
 * install (D-AC).
 */
export type StaticAnalysisScanScope = 'default' | 'deep';

export type StaticAnalysisFindingKind =
  /** Static ESM `import`/`export ... from` specifier. */
  | 'esm-import'
  /** `import(...)` with a string-literal specifier. */
  | 'dynamic-import'
  /** `require(...)` with a string-literal argument. */
  | 'cjs-require'
  /** Forbidden package named in the plugin `package.json` dependencies. */
  | 'declared-dependency'
  /** Forbidden package present in the plugin lockfile. */
  | 'lockfile-package'
  /** `import(x)` whose specifier is not a string literal — unscreenable. */
  | 'non-literal-import'
  /** `require(x)` whose argument is not a string literal — unscreenable. */
  | 'non-literal-require'
  /** The file could not be read and therefore could not be screened. */
  | 'read-failure'
  /** The file could not be parsed and therefore could not be screened. */
  | 'parse-failure';

export interface StaticAnalysisFinding {
  /** Path relative to the plugin root (or the descriptor filename for dependency findings). */
  readonly file: string;
  readonly kind: StaticAnalysisFindingKind;
  /** The matched specifier / package name; `null` where none exists (non-literal, read or parse failure). */
  readonly specifier: string | null;
  readonly severity: StaticAnalysisSeverity;
  readonly scanScope: StaticAnalysisScanScope;
}

export interface StaticAnalysisReport {
  readonly findings: readonly StaticAnalysisFinding[];
  /** Files scanned by the default pass (plugin code, `node_modules` excluded). */
  readonly scannedFileCount: number;
  /** Files scanned by the opt-in deep pass; 0 when deep scan was off. */
  readonly deepScannedFileCount: number;
  /**
   * True when advisory findings were dropped at the cap below. Surfaced on
   * the install response so a truncated report never reads as a complete
   * one; gating findings are never dropped, so this can never hide a
   * rejection.
   */
  readonly truncated: boolean;
}

/**
 * Upper bound on ADVISORY findings carried in one report. These ride the
 * `plugin.installed` event into the lifecycle row's `payload` JSON, the
 * audit log, and the install response, so an unbounded count is a real
 * operational hazard rather than a theoretical one: a deep scan of a
 * realistic `node_modules` produces thousands of rows on its own.
 *
 * Gating findings are exempt — they are what the rejection reports, and a
 * cap that could swallow one would be a correctness bug, not a size win.
 */
export const MAX_ADVISORY_FINDINGS = 200;

/**
 * Example findings retained per distinct gating specifier. Gating findings
 * are exempt from the advisory cap — they are the content of a rejection —
 * but an ACCEPTED install persists them into `PluginLifecycleEvent.payload`,
 * so 5,000 files importing `axios` would write 5,000 rows of JSON to record
 * one acknowledged specifier. Capping per specifier bounds the payload while
 * keeping the specifier SET complete, which is what the gate and the
 * acknowledgement both key on.
 */
export const MAX_GATING_EXAMPLES_PER_SPECIFIER = 3;

/**
 * The findings that BLOCK an install: forbidden specifiers reached by the
 * default scan. Everything else — warnings of any scope and ALL deep-scan
 * findings — is recorded in the install audit payload and the install
 * response, never gating (D-AC).
 */
export const gatingFindings = (report: StaticAnalysisReport): readonly StaticAnalysisFinding[] =>
  report.findings.filter((finding) => isGatingFinding(finding));

/** Single definition of the gating predicate, shared with the analyzer's cap accounting. */
export const isGatingFinding = (finding: StaticAnalysisFinding): boolean =>
  finding.severity === 'forbidden' && finding.scanScope === 'default';
