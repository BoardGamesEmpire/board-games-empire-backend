import { isWellFormedBcp47 } from '@boardgamesempire/plugin-manifest';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { valid } from 'semver';
import { BGE_VERSION } from './generated/bge-version.js';
import { message } from './messages.js';
import type { ArtifactOutcome, ReportItem, ValidationReport } from './report.js';
import { renderErrorLine, renderJson, renderText } from './report.js';
import { ToolkitError } from './toolkit.errors.js';

export interface CliIo {
  stderr: { write(text: string): unknown };
  stdout: { write(text: string): unknown };
}

export interface ValidateOptions {
  /** Forbidden imports the plugin author accepts, as a server admin can when installing. */
  readonly acceptImports: readonly string[];

  /** An earlier version of the plugin, as its manifest.json or plugin artifact, to compare consent requirements with. */
  readonly against?: string;

  readonly bgeVersion: string;
  readonly defaultLocale: string;
}

export interface BuildOptions extends ValidateOptions {
  readonly outDir: string;
}

export interface BuildOutcome {
  /** Present only when the plugin artifact was written, so never alongside an error. */
  readonly artifact?: ArtifactOutcome;

  readonly report: ValidationReport;
}

/** What each command does, injectable so the command line is tested without running npm (#1093). */
export interface CliCommands {
  build(projectDir: string, options: BuildOptions): Promise<BuildOutcome>;
  validate(target: string, options: ValidateOptions): Promise<ValidationReport>;
}

const notBuiltYet = (command: string): never => {
  throw new Error(`bge-plugin ${command} is not part of this build yet (#1093).`);
};

const DEFAULT_COMMANDS: CliCommands = {
  build: async () => notBuiltYet('build'),
  validate: async () => notBuiltYet('validate'),
};

const DEFAULT_LOCALE = 'en';
const DEFAULT_OUT_DIR = 'bge-artifacts';

const OPTIONS = {
  'accept-import': { multiple: true, type: 'string' },
  against: { type: 'string' },
  'bge-version': { type: 'string' },
  'default-locale': { type: 'string' },
  help: { short: 'h', type: 'boolean' },
  json: { type: 'boolean' },
  'out-dir': { type: 'string' },
} as const;

const USAGE_TEXT = `Usage: bge-plugin <command> [options]

Checks a plugin and builds its plugin artifact, using the same checks a Board
Games Empire server runs when a server admin installs a plugin.

Commands:
  validate <path>   Check a plugin folder, or a plugin artifact (.tgz), and
                    report everything a server would refuse.
  build [path]      Check the plugin in a folder (the current folder when no
                    path is given), then write its plugin artifact and the
                    artifact's checksum file.

Options:
  --accept-import <name>   Accept one forbidden import by name, as a server
                           admin can when installing. Repeat it for each name.
  --against <file>         Compare with an earlier version of the plugin, given
                           as its manifest.json or plugin artifact, to see
                           which permissions households and users would newly
                           have to consent to.
  --bge-version <version>  The Board Games Empire version to check the plugin
                           manifest's bgeCompat range against. Default:
                           ${BGE_VERSION}, the version this command was built from.
  --default-locale <tag>   The server's default language, which every
                           translated text in the plugin manifest must include.
                           Default: ${DEFAULT_LOCALE}.
  --out-dir <folder>       build only: where to write the plugin artifact.
                           Default: ${DEFAULT_OUT_DIR} in the plugin folder.
  --json                   Print the report as one JSON document.
  -h, --help               Show this help.

Exit codes: 0 when there are no errors, 1 when there is at least one error,
2 when the command line was not understood.
`;

const HELP_HINT = 'Run "bge-plugin --help" to see the commands and options.\n';

type Invocation =
  | { readonly kind: 'help' }
  | { readonly json: boolean; readonly kind: 'validate'; readonly options: ValidateOptions; readonly target: string }
  | { readonly json: boolean; readonly kind: 'build'; readonly options: BuildOptions; readonly projectDir: string };

const usageError = (detail: string): ToolkitError => new ToolkitError('USAGE', undefined, detail);

/** Node's own words for a bad option, cut to their first sentence. */
const parseArgsDetail = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const [first = text] = text.split('. ');

  return first.endsWith('.') ? first : `${first}.`;
};

const parseInvocation = (argv: readonly string[]): Invocation => {
  let parsed;

  try {
    parsed = parseArgs({ allowPositionals: true, args: [...argv], options: OPTIONS, strict: true });
  } catch (error) {
    throw usageError(parseArgsDetail(error));
  }

  const { positionals, values } = parsed;

  if (argv.length === 0 || values.help === true) {
    return { kind: 'help' };
  }

  const [command, ...paths] = positionals;

  if (command !== 'validate' && command !== 'build') {
    throw usageError(
      command === undefined
        ? 'Name a command: validate or build.'
        : `There is no command ${JSON.stringify(command)}; the commands are validate and build.`,
    );
  }

  const bgeVersion = values['bge-version'] === undefined ? BGE_VERSION : valid(values['bge-version']);

  if (bgeVersion === null) {
    throw usageError(`--bge-version needs a version such as 1.2.3, not ${JSON.stringify(values['bge-version'])}.`);
  }

  const defaultLocale = values['default-locale'] ?? DEFAULT_LOCALE;

  if (!isWellFormedBcp47(defaultLocale)) {
    throw usageError(
      `--default-locale needs a language tag such as en or de-AT, not ${JSON.stringify(defaultLocale)}.`,
    );
  }

  const options: ValidateOptions = {
    acceptImports: values['accept-import'] ?? [],
    ...(values.against === undefined ? {} : { against: resolve(values.against) }),
    bgeVersion,
    defaultLocale,
  };
  const json = values.json === true;

  if (command === 'validate') {
    if (values['out-dir'] !== undefined) {
      throw usageError('--out-dir is an option of build only.');
    }

    const [target] = paths;

    if (target === undefined || paths.length > 1) {
      throw usageError('validate takes one path: a plugin folder or a plugin artifact (.tgz).');
    }

    return { json, kind: 'validate', options, target: resolve(target) };
  }

  if (paths.length > 1) {
    throw usageError('build takes at most one path: the plugin folder.');
  }

  const projectDir = resolve(paths[0] ?? process.cwd());
  const outDir = values['out-dir'] === undefined ? join(projectDir, DEFAULT_OUT_DIR) : resolve(values['out-dir']);

  return { json, kind: 'build', options: { ...options, outDir }, projectDir };
};

/** 2 for a usage error, 1 for any other error, 0 for none. */
const exitCodeFor = (report: ValidationReport): number => {
  if (report.errors.some((item) => item.code === 'USAGE')) {
    return 2;
  }

  return report.errors.length > 0 ? 1 : 0;
};

const render = (outcome: BuildOutcome, json: boolean): string => {
  if (json) {
    return renderJson(outcome);
  }

  const text = renderText(outcome.report);
  const { artifact } = outcome;

  return artifact === undefined
    ? text
    : `${text}Wrote the plugin artifact ${artifact.path} and its checksum file ${artifact.sidecarPath}.\nsha256: ${artifact.sha256}\n`;
};

/**
 * Whether `--json` was asked for, read from the raw arguments so that a
 * command line that doesn't parse still answers in JSON for a CI that reads
 * stdout (#1093). Anything after `--` is a path, not an option.
 */
const wantsJson = (argv: readonly string[]): boolean => {
  const end = argv.indexOf('--');

  return (end === -1 ? argv : argv.slice(0, end)).includes('--json');
};

/**
 * One failure that is not a report from a command. With `--json` it is one
 * JSON document on stdout and nothing on stderr; without it, one error line
 * on stderr.
 */
const printFailure = (io: CliIo, item: ReportItem, json: boolean, hint = ''): void => {
  if (json) {
    io.stdout.write(renderJson({ report: { errors: [item], notes: [], warnings: [] } }));
  } else {
    io.stderr.write(`${renderErrorLine(item)}${hint}`);
  }
};

/** Never a stack trace: the first line of whatever was thrown, under its own code (#1093). */
const reportUnexpected = (io: CliIo, error: unknown, json: boolean): number => {
  const text = error instanceof Error ? error.message || error.name : String(error);
  const [first = ''] = text.split(/\r?\n/);
  // The message ends its own sentence; a full stop inside the quotes too reads twice.
  const detail = first.replace(/\.$/, '');

  printFailure(io, { code: 'UNEXPECTED_ERROR', message: message('UNEXPECTED_ERROR', { detail }) }, json);

  return 1;
};

/**
 * Runs `bge-plugin` with `argv` (the arguments after the command name) and
 * resolves the exit code; it never rejects (#1093). Reports go to stdout, as
 * text or with `--json` as one JSON document. Without `--json`, a usage error
 * or an unexpected error is one line on stderr; with it, it is one JSON
 * document on stdout like any report.
 */
export const runCli = async (
  argv: readonly string[],
  io: CliIo,
  commands: Partial<CliCommands> = {},
): Promise<number> => {
  let invocation: Invocation;

  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    if (!(error instanceof ToolkitError)) {
      return reportUnexpected(io, error, wantsJson(argv));
    }

    printFailure(io, error.toReportItem(), wantsJson(argv), HELP_HINT);

    return 2;
  }

  if (invocation.kind === 'help') {
    io.stdout.write(USAGE_TEXT);

    return 0;
  }

  const chosen: CliCommands = {
    build: (projectDir, options) =>
      commands.build ? commands.build(projectDir, options) : DEFAULT_COMMANDS.build(projectDir, options),
    validate: (target, options) =>
      commands.validate ? commands.validate(target, options) : DEFAULT_COMMANDS.validate(target, options),
  };

  try {
    const outcome: BuildOutcome =
      invocation.kind === 'validate'
        ? { report: await chosen.validate(invocation.target, invocation.options) }
        : await chosen.build(invocation.projectDir, invocation.options);

    io.stdout.write(render(outcome, invocation.json));

    return exitCodeFor(outcome.report);
  } catch (error) {
    if (!(error instanceof ToolkitError)) {
      return reportUnexpected(io, error, invocation.json);
    }

    const report: ValidationReport = { errors: [error.toReportItem()], notes: [], warnings: [] };

    io.stdout.write(render({ report }, invocation.json));

    return exitCodeFor(report);
  }
};
