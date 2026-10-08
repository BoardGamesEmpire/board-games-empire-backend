import { errors, type Browser, type ConsoleMessage, type Response } from 'playwright';

/**
 * Loading the bundled web client in a browser, from the api's origin, and
 * recording what a person's browser would show had something gone wrong.
 *
 * What it knows of the client is the client's own, as of client 11d0213, and
 * each is named below with where the client defines it.
 */

const IDENTITY_PATH = '/.well-known/bge-identity';

/**
 * Where the client settles once its boot is done: signed out, or on its
 * startup failure screen (`AppRoutes.auth` and `AppRoutes.error`, client
 * packages/app_shell/lib/src/router/app_router.dart).
 */
const SETTLED_PATHS = new Set(['/auth', '/error']);

/** A boot that has to fetch the identity document, open the database and route: generous on a slow runner. */
const SETTLE_TIMEOUT_MS = 60_000;

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

export interface ClientVisit {
  /** The status the navigation itself got. */
  readonly documentStatus: number | undefined;

  /** The status of the client's own fetch of the identity document, if it made one. */
  readonly identityStatus: number | undefined;

  /** The path the client settled on. */
  readonly settledPath: string;

  /** The names of the IndexedDB databases the page holds once settled. */
  readonly databases: readonly string[];

  /** Console errors, CSP violations, uncaught exceptions and the client's own error lines. */
  readonly problems: readonly string[];
}

function describeMessage(message: ConsoleMessage): string {
  const where = message.worker() ? `worker ${message.worker()?.url()}` : message.location().url;
  return `console ${message.type()} (${where}): ${message.text()}`;
}

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

/**
 * Opens `path` in a fresh browser context, as a first visit, and waits for
 * the client to settle. The console is read from the page and its workers.
 * A client that never settles is reported where it stopped, with everything
 * else the visit saw, rather than as a bare timeout.
 */
export async function visitClient(browser: Browser, baseUrl: string, path: string): Promise<ClientVisit> {
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    const problems: string[] = [];
    let identity: Response | undefined;

    page.on('console', (message) => {
      if (isProblemMessage(message.type(), message.text())) {
        problems.push(describeMessage(message));
      }
    });
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === IDENTITY_PATH) {
        identity = response;
      }
    });

    const navigation = await page.goto(new URL(path, baseUrl).href, { waitUntil: 'load' });
    try {
      await page.waitForURL((url) => SETTLED_PATHS.has(url.pathname), { timeout: SETTLE_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) {
        throw error;
      }

      problems.push(`not settled within ${SETTLE_TIMEOUT_MS / 1000}s`);
    }

    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).flatMap(({ name }) => (name ? [name] : [])),
    );

    return {
      documentStatus: navigation?.status(),
      identityStatus: identity?.status(),
      settledPath: new URL(page.url()).pathname,
      databases,
      problems,
    };
  } finally {
    await context.close();
  }
}
