import type { StaticAnalysisFindingKind } from '@boardgamesempire/plugin-analysis';
import {
  MAX_ADVISORY_FINDINGS,
  MAX_GATING_EXAMPLES_PER_SPECIFIER,
  quoteUntrustedText,
} from '@boardgamesempire/plugin-analysis';
import type { PluginArchiveRule } from '@boardgamesempire/plugin-manifest';
import {
  PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES,
  PLUGIN_ARCHIVE_MAX_ENTRIES,
  PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES,
  PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES,
} from '@boardgamesempire/plugin-manifest';

/**
 * The report codes the plugin author CLI raises itself, beside the server's
 * own archive rules, manifest codes and finding kinds (#1093). The type comes
 * from this list, so a new code can't be used before it has a message below.
 */
export const TOOLKIT_MESSAGE_CODES = [
  'USAGE',
  'MANIFEST_UNREADABLE',
  'PLUGIN_PERMISSION_FORBIDDEN',
  'FORBIDDEN_IMPORT_ACCEPTED',
  'ACCEPTED_IMPORT_NOT_FOUND',
  'AGAINST_UNREADABLE',
  'CONSENT_COMPARISON_SKIPPED',
  'NOT_CHECKED_PERMISSION_CATALOG',
  'NOT_CHECKED_BEYOND_SCAN',
  'LOCKFILE_MISSING',
  'LOCKFILE_UNSUPPORTED',
  'PLUGIN_BUILD_FAILED',
  'NPM_PACK_FAILED',
  'DEPENDENCY_INSTALL_FAILED',
  'SYMLINK_REFUSED',
  // A token written into a dependency's URL would ship to every server that
  // installs the plugin (#1093).
  'URL_CREDENTIALS_REFUSED',
  'ARTIFACT_TOO_LARGE',
  // A file left out of a plugin artifact breaks the plugin at runtime, so the
  // plugin author hears about it (#1093).
  'PLUGIN_ARTIFACT_LEFT_OUT',
  // A scan report the server cut short says so, so a long list of warnings
  // never reads as the complete one (#1093).
  'SCAN_REPORT_TRUNCATED',
  // Every line the CLI prints carries a stable code, the line for an error
  // nobody foresaw included (#1093).
  'UNEXPECTED_ERROR',
] as const;

export type ToolkitMessageCode = (typeof TOOLKIT_MESSAGE_CODES)[number];

/**
 * Every code with a message in the table. Manifest codes are left out on
 * purpose: an issue with the plugin manifest prints the validator's own
 * message, so the CLI and the server word it the same way (#1093).
 */
export type MessageCode = ToolkitMessageCode | PluginArchiveRule | StaticAnalysisFindingKind;

const mebibytes = (bytes: number): string => `${bytes / 1024 / 1024} MiB`;

/**
 * One English message per code (#1093). `{name}` placeholders are filled by
 * `message()`. Copy follows GLOSSARY.md: "plugin artifact", never a bare
 * "package"; `package.json` and `package-lock.json` are npm's own file names.
 */
const MESSAGES: Readonly<Record<MessageCode, string>> = {
  USAGE: 'The command was not understood.',
  MANIFEST_UNREADABLE:
    'The plugin has no readable manifest.json: the file is missing, is not valid JSON, or does not hold a JSON object.',
  PLUGIN_PERMISSION_FORBIDDEN:
    'The plugin manifest names the permission {permission}, which no plugin may hold, so a server refuses to install it.',
  FORBIDDEN_IMPORT_ACCEPTED:
    'The code uses {specifier}, a forbidden import you accepted with --accept-import. A server refuses the install unless the server admin installing it accepts the same import.',
  ACCEPTED_IMPORT_NOT_FOUND:
    'You accepted {specifier} with --accept-import, but the scan found no forbidden import of it. Drop the option if the plugin no longer needs it.',
  AGAINST_UNREADABLE:
    'The earlier version of the plugin given with --against could not be read as a plugin manifest or a plugin artifact, so nothing was compared.',
  CONSENT_COMPARISON_SKIPPED:
    'The plugin manifest was not compared with an earlier version of the plugin, so this report does not show which permissions households and users would newly have to consent to.',
  NOT_CHECKED_PERMISSION_CATALOG:
    "Some checks need a server's permission catalog, so they were not made here: that each core permission the plugin manifest requests exists, that none of them covers every kind of data, and that each one requested at household or user consent scope is limited to that household or user. A server makes these checks when the plugin is installed.",
  NOT_CHECKED_BEYOND_SCAN:
    'The scan reads the code for forbidden imports without running it, so it cannot see a network call through the global fetch, which needs no import, an HTTP client written over a raw socket, whose import is only a warning, or code built at runtime with eval. A clean report is not a security guarantee.',
  LOCKFILE_MISSING:
    'The plugin has no package-lock.json. Run npm install to create one: the build installs exactly the dependency versions it records.',
  LOCKFILE_UNSUPPORTED:
    'The package-lock.json is in a form the build cannot read. Run npm install with npm 7 or later to update it.',
  PLUGIN_BUILD_FAILED: "The plugin's own build script failed (npm run build).",
  NPM_PACK_FAILED: "npm could not list the plugin's files (npm pack --dry-run).",
  DEPENDENCY_INSTALL_FAILED: "npm could not install the plugin's dependencies from package-lock.json (npm ci).",
  SYMLINK_REFUSED:
    'The plugin holds a symbolic link or another special file, which a plugin artifact may not contain. Replace it with the file or folder it stands for.',
  URL_CREDENTIALS_REFUSED:
    'This file holds a URL with a user name or password in it, at {field}, and the file ships in the plugin artifact. Take the credentials out of every URL in the file and give them to npm another way, such as an auth token in the .npmrc in your home folder, or a git credential helper, then run npm install again.',
  ARTIFACT_TOO_LARGE: `The plugin artifact is larger than the ${mebibytes(PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES)} a server accepts.`,
  PLUGIN_ARTIFACT_LEFT_OUT:
    '{entry} is left out of the plugin artifact because its name ends like a plugin artifact or its checksum. If the plugin needs this file, rename it.',
  SCAN_REPORT_TRUNCATED: `The scan found more than its report can hold, so it lists at most ${MAX_ADVISORY_FINDINGS} warnings, and at most ${MAX_GATING_EXAMPLES_PER_SPECIFIER} files for each forbidden import. Every forbidden import is still named.`,
  UNEXPECTED_ERROR: 'bge-plugin stopped on an unexpected error: {detail}.',

  'not-gzip': 'The plugin artifact is not a gzip-compressed archive.',
  corrupt: 'The plugin artifact is damaged, or two of its entries land on the same path.',
  'entry-type': 'The plugin artifact holds {entry}, which is neither a file nor a folder (a link, for example).',
  'unsafe-path': 'The plugin artifact holds the name {entry}, which reaches outside its folder or is too long.',
  'top-level': 'The plugin artifact holds {entry} outside its one top-level folder.',
  'entry-count': `The plugin artifact creates more than ${PLUGIN_ARCHIVE_MAX_ENTRIES.toLocaleString('en')} files and folders, and passes that limit at {entry}.`,
  'extracted-size': `The plugin artifact unpacks to more than ${mebibytes(PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES)}.`,
  'required-file': 'The plugin artifact has no {entry} in its top-level folder, and every plugin needs one.',
  'manifest-slug': "The plugin artifact's manifest.json does not give a usable slug.",
  'manifest-size': `The plugin artifact's manifest.json is larger than ${mebibytes(PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES)}.`,

  'esm-import': 'The code imports {specifier}, a forbidden import.',
  'dynamic-import': 'The code loads {specifier} with import(), a forbidden import.',
  'cjs-require': 'The code loads {specifier} with require(), a forbidden import.',
  'declared-dependency': 'package.json depends on {specifier}, a forbidden import.',
  'lockfile-package': 'package-lock.json installs {specifier}, a forbidden import.',
  'non-literal-import': 'The code calls import() with a name the scan cannot read, so it cannot tell what is loaded.',
  'non-literal-require': 'The code calls require() with a name the scan cannot read, so it cannot tell what is loaded.',
  'read-failure': 'The scan could not read this file, so it was not checked.',
  'parse-failure': 'The scan could not parse this file, so it was not checked.',
};

/**
 * Why the consent comparison did not run, appended to CONSENT_COMPARISON_SKIPPED
 * (#1093). A sentence of the CLI's own, not a `{placeholder}`: `message()`
 * quotes every value it fills in, as text from the plugin, and these are not.
 */
export const CONSENT_COMPARISON_SKIPPED_REASONS = {
  invalidManifest: 'Fix the errors in the plugin manifest first, then run validate again with --against.',
  noAgainst: "Pass --against with that version's manifest.json or plugin artifact to compare them.",
} as const;

/**
 * The message for `code`, with each `{name}` filled from `params`, quoted and
 * cut by `quoteUntrustedText`, as the server's `PluginArchiveRefusedError`
 * prints an entry name. Every value is quoted, because most come from the
 * plugin (an entry name, an import), so none can forge or flood a report line.
 * A placeholder with no value stays visible rather than throwing in the middle
 * of rendering a report (#1093).
 */
export const message = (code: MessageCode, params: Readonly<Record<string, string>> = {}): string =>
  MESSAGES[code].replace(/\{([a-zA-Z]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? quoteUntrustedText(params[name]) : placeholder,
  );
