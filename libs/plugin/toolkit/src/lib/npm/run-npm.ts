import { execFile } from 'node:child_process';

/**
 * npm's JSON listing of a large plugin, or its install log, can pass Node's
 * 1 MiB default for captured output, which would kill npm mid-run (#1093).
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * npm ran and failed with `exitCode`, or never ran to an exit code (it could
 * not be started, its output overran the buffer, a signal stopped it): then
 * `exitCode` is null and `stderr` holds Node's account of why (#1093). On
 * Windows npm runs through a shell, so a missing npm is the shell's failure
 * and arrives with a number. When npm fails without printing anything on
 * stderr, `stderr` holds Node's account too, so a report never quotes nothing.
 */
export class NpmCommandError extends Error {
  override readonly name = 'NpmCommandError';

  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`npm ${args.join(' ')} failed${exitCode === null ? '' : ` with exit code ${exitCode}`}.`);
  }
}

/** How much of npm's output a report quotes: the end, where npm says what failed. */
const NPM_OUTPUT_LINES = 20;

/**
 * A failed npm run in a report's words (#1093): "npm could not be run" with
 * Node's reason when npm never ran to an exit code (so the plugin is not
 * the problem), else the end of what npm printed on stderr.
 */
export const describeNpmFailure = (error: NpmCommandError): string => {
  const lines = error.stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  const end = lines.slice(-NPM_OUTPUT_LINES).join('\n');

  if (error.exitCode === null) {
    return `npm could not be run: ${end}`;
  }

  return lines.length > NPM_OUTPUT_LINES ? `npm's last ${NPM_OUTPUT_LINES} lines:\n${end}` : `npm said:\n${end}`;
};

/**
 * Runs npm with `args` in `cwd` and resolves with what it printed on stdout
 * (#1093). The child inherits this process's environment: npm takes its
 * project from `cwd`, not from the variables a parent npm (npx, npm run)
 * sets.
 *
 * The rule for callers: pass fixed flags only. Windows needs a shell to find
 * `npm.cmd`, and with `shell: true` Node joins the arguments into one command
 * line unquoted, so a path with a space, or a plugin author's text, would be
 * split or read by the shell. Never pass a path or author text as an
 * argument; `cwd` carries the directory.
 */
export const runNpm = (args: readonly string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'npm',
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, shell: process.platform === 'win32' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }

        const exitCode = typeof error.code === 'number' ? error.code : null;
        reject(new NpmCommandError(args, exitCode === null || stderr.trim() === '' ? error.message : stderr, exitCode));
      },
    );
  });
