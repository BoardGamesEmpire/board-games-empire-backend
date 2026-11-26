import type { StaticAnalysisFindingKind } from '@boardgamesempire/plugin-analysis';
import { quoteUntrustedText } from '@boardgamesempire/plugin-analysis';
import type { ManifestErrorCode, ManifestWarningCode, PluginArchiveRule } from '@boardgamesempire/plugin-manifest';
import type { ToolkitMessageCode } from './messages.js';

/**
 * Every report line carries one code (#1093): the server's own archive rule,
 * manifest code or finding kind where the server reaches the same verdict, so
 * a plugin author can match the CLI's report to the server's refusal, or one
 * of the CLI's own.
 */
export type ReportCode =
  ToolkitMessageCode | PluginArchiveRule | ManifestErrorCode | ManifestWarningCode | StaticAnalysisFindingKind;

export interface ReportItem {
  /** Where the problem is: a file, an archive entry or a path in the plugin manifest. */
  readonly at?: string;

  readonly code: ReportCode;
  readonly message: string;
}

/**
 * Errors are what a server would refuse; warnings are worth a plugin author's
 * attention but block nothing; notes say what was not checked.
 */
export interface ValidationReport {
  readonly errors: readonly ReportItem[];
  readonly notes: readonly ReportItem[];
  readonly warnings: readonly ReportItem[];
}

export interface ArtifactOutcome {
  readonly path: string;
  readonly sha256: string;
  readonly sidecarPath: string;
}

/** What a command ends with: its report and, for a `build` that wrote one, the plugin artifact. */
export interface BuildOutcome {
  /** Present only when the plugin artifact was written, so never alongside an error. */
  readonly artifact?: ArtifactOutcome;

  readonly report: ValidationReport;
}

/** A report that stopped at one error, with nothing else checked (#1093). */
export const reportWithError = (item: ReportItem): ValidationReport => ({ errors: [item], notes: [], warnings: [] });

/** The reports' errors, warnings and notes, each list in the order the reports are given. */
export const mergeReports = (...reports: readonly ValidationReport[]): ValidationReport => ({
  errors: reports.flatMap((report) => report.errors),
  notes: reports.flatMap((report) => report.notes),
  warnings: reports.flatMap((report) => report.warnings),
});

type Severity = 'error' | 'warning' | 'note';

/**
 * A location prints bare while it is one plain word. Anything else (a space,
 * a quote, a line break, a 300-character name from a hostile plugin artifact)
 * prints quoted and cut, as `message()` prints an entry name, so it cannot
 * break the line form a script reads (#1093).
 */
const isPlainWord = (at: string): boolean => {
  const quoted = JSON.stringify(at);

  return quoted === `"${at}"` && !/\s/.test(at) && quoted.length <= 200;
};

const printableAt = (at: string): string => (isPlainWord(at) ? at : quoteUntrustedText(at));

/**
 * `<severity> <code> <at>: <message>`, with `<at>` left out when absent. A
 * message's later lines (npm's own output, for one) are indented, so every
 * line that starts a report item starts with a severity.
 */
const renderItem = (severity: Severity, item: ReportItem): string => {
  const head = item.at === undefined ? `${severity} ${item.code}` : `${severity} ${item.code} ${printableAt(item.at)}`;
  const [first = '', ...rest] = item.message.split(/\r?\n/);

  return [`${head}: ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
};

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The report as text: errors, then warnings, then notes, then a summary line. */
export const renderText = (report: ValidationReport): string => {
  const lines = [
    ...report.errors.map((item) => renderItem('error', item)),
    ...report.warnings.map((item) => renderItem('warning', item)),
    ...report.notes.map((item) => renderItem('note', item)),
    `${count(report.errors.length, 'error')}, ${count(report.warnings.length, 'warning')}`,
  ];

  return `${lines.join('\n')}\n`;
};

/** One error line with no summary, for a usage error printed on stderr. */
export const renderErrorLine = (item: ReportItem): string => `${renderItem('error', item)}\n`;

/** The report as one JSON document; `ok` is true when there is no error. */
export const renderJson = (outcome: BuildOutcome): string => {
  const { artifact, report } = outcome;
  const document = {
    ok: report.errors.length === 0,
    ...(artifact === undefined ? {} : { artifact }),
    errors: report.errors,
    warnings: report.warnings,
    notes: report.notes,
  };

  return `${JSON.stringify(document, null, 2)}\n`;
};
