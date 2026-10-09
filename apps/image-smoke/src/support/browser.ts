import { errors, type Browser, type ConsoleMessage, type Response } from 'playwright';
import { isProblemMessage } from './web-client';

/**
 * Loading the bundled web client in a browser, from the api's origin, and
 * recording what a person's browser would show had something gone wrong.
 * Only the smoke suite runs it. What can be checked without a browser is in
 * web-client.ts, with its unit tests.
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
