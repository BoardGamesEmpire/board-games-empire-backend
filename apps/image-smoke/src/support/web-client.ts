/**
 * What the suite knows of the bundled web client, and of how Chromium reports
 * a problem with it: what can be checked without a browser, with its unit
 * tests. browser.ts drives the client, and only the smoke suite runs it.
 *
 * What it knows of the client is the client's own, as of client 11d0213, and
 * each is named below with where the client defines it.
 */

/**
 * An error line of the client's own. It logs through `print`, so the line
 * arrives as a console `log`, not an error. Its levels are VERBOSE, DEBUG,
 * INFO, WARN and ERROR (`LogRecordFormatter`, client
 * packages/core/observability/lib/src/logging/log_record_formatter.dart),
 * and a release build prints WARN and above. Should that format change, this
 * stops matching, and a client error that leaves the boot on its way counts
 * for nothing here; one that stops the boot still settles on `/error`.
 */
const CLIENT_ERROR_LOG = /\[ERROR\] /;

/** How Chromium reports a refusal under a Content-Security-Policy. */
const CSP_VIOLATION = /Content Security Policy|Refused to (load|execute|compile|connect|create|evaluate|apply|frame)/i;

/**
 * Whether a console message reports a problem: any console error, any CSP
 * refusal whatever its type, and the client's own error lines. Warnings
 * alone are not: headless Chromium warns about its own GPU driver.
 */
export function isProblemMessage(type: string, text: string): boolean {
  return type === 'error' || CSP_VIOLATION.test(text) || CLIENT_ERROR_LOG.test(text);
}

/**
 * The drift database the client opens for a server: `bge_server_` and the
 * server's id, with anything but letters, digits and `_` replaced by `_`
 * (`WasmExecutorFactory.databaseName`, client
 * packages/storage/web_storage/lib/src/databases/wasm_executor_factory.dart).
 * It exists only once the client has opened its database for that server.
 */
export function driftDatabaseName(serverId: string): string {
  return `bge_server_${serverId.replace(/[^A-Za-z0-9_]/g, '_')}`;
}
