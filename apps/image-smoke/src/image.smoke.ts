import { performSignup, type SignupResult } from '@bge/testing-e2e/signup';
import { chromium, type Browser } from 'playwright';
import {
  awaitImport,
  currentUser,
  readGame,
  registerGateway,
  searchGateway,
  searchGatewayOverSocket,
  signIn,
  startImport,
  type Session,
} from './support/api';
import { driftDatabaseName, visitClient } from './support/browser';
import { recordFields, unexpectedErrors } from './support/logs';
import { GATEWAYS, KEEP_STACK, ROLES, Stack } from './support/stack';

/**
 * The images as a self-hoster runs them (#600): the split profile, with every
 * role and both gateway images started from the images under test on an
 * empty database, and driven from outside, over HTTP, Socket.IO and a
 * browser. One stack serves the whole run, in order: each step below builds
 * on the ones before it, and the last ones stop the stack.
 *
 * It runs on the images CI builds for each platform. Locally, build them
 * first (`docker compose --profile split build`), then run the `smoke` target.
 */

/** What the stub gateway serves: apps/stub-gateway/src/app/fixtures/catalog.ts. */
const STUB = {
  address: { connectionUrl: 'stub-gateway', connectionPort: 50051 },
  query: 'Stub Island',
  baseGame: { externalId: 'stub-1001', title: 'Stub Island' },
  expansion: { externalId: 'stub-1002', title: 'Stub Island: Harbours' },
};

const TEARDOWN_TIMEOUT_MS = 5 * 60_000;

/** The label in which the BGE image names the web client it carries (#598). */
const WEB_CLIENT_LABEL = 'io.github.boardgamesempire.web.image';

/** The events by which a search over Socket.IO reports that a source, the frame or the session failed. */
const SOCKET_FAILURES = new Set([
  'search:error',
  'search:unavailable',
  'search:rate_limited',
  'exception',
  'auth:error',
]);

/** A value an earlier step sets, named when that step failed to. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`No ${what}: the step that provides it failed`);
  }

  return value;
}

describe('the BGE images, run as the split profile', () => {
  let stack: Stack;

  // Building the stub's image, then a first boot, in which the api migrates
  // and seeds while the others wait.
  beforeAll(async () => {
    stack = await Stack.start();
  }, Stack.START_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.teardown();
  }, TEARDOWN_TIMEOUT_MS);

  describe('a first boot, on an empty database', () => {
    it('migrates and seeds the database from the api', async () => {
      const record = (await stack.records('api')).find(({ text }) => text.includes('Bootstrap complete'));
      const summary = record && recordFields(record);

      expect(summary).toMatchObject({ state: 'behind', seedsRun: true, unknownMigrations: [] });
      expect(summary?.['migrationsApplied']).toEqual(expect.arrayContaining([expect.any(String)]));
    });

    it.each(ROLES)('runs the %s role, which logged that its boot completed', async (role) => {
      const records = await stack.records(role);

      expect(records.some(({ text }) => text.includes('Bootstrap complete'))).toBe(true);
      expect(await stack.state(role)).toMatchObject({ status: 'running', restartCount: 0 });
    });

    it.each(GATEWAYS)('runs the %s, healthy', async (gateway) => {
      expect(await stack.state(gateway)).toMatchObject({ status: 'running', health: 'healthy', restartCount: 0 });
    });

    it('names the web client it carries, by digest', async () => {
      const reference = await stack.imageLabel('api', WEB_CLIENT_LABEL);
      console.log(`[smoke] the BGE image carries the web client ${reference}`);

      expect(reference).toMatch(/^ghcr\.io\/boardgamesempire\/bge-client-web:[\w.-]+@sha256:[0-9a-f]{64}$/);
    });
  });

  let account: SignupResult | undefined;
  let session: Session | undefined;

  describe('accounts', () => {
    it('signs the first account up', async () => {
      account = await performSignup(stack.baseUrl);

      expect(account.userId).toEqual(expect.any(String));
    });

    it('signs it in', async () => {
      const { email, password, userId } = required(account, 'account');
      session = await signIn(stack.baseUrl, email, password);

      await expect(currentUser(stack.baseUrl, session)).resolves.toMatchObject({ id: userId, email });
    });
  });

  describe('search and import, through the stub gateway', () => {
    let gatewayId: string | undefined;
    let gameId: string | undefined;

    it('registers the stub gateway as the owner, and the coordinator reaches it', async () => {
      const registration = await registerGateway(stack.baseUrl, required(session, 'session'), {
        name: 'Stub',
        ...STUB.address,
      });

      expect(registration).toMatchObject({ connection_attempt: true, connection_response: { success: true } });
      gatewayId = registration.gateway.id;
    });

    it('finds its games over HTTP, through the coordinator', async () => {
      const id = required(gatewayId, 'gateway');
      const response = await searchGateway(stack.baseUrl, required(session, 'session'), id, STUB.query);

      expect(response.errors).toBeUndefined();
      expect(response.resultsBySource[id]).toEqual([
        expect.objectContaining({ ...STUB.baseGame, inSystem: false }),
        expect.objectContaining({ ...STUB.expansion, inSystem: false }),
      ]);
    });

    it('imports a game: gateway-fetch fetches it, and the worker stores it', async () => {
      const current = required(session, 'session');
      const { batchId } = await startImport(
        stack.baseUrl,
        current,
        required(gatewayId, 'gateway'),
        STUB.baseGame.externalId,
      );
      const batch = await awaitImport(stack.baseUrl, current, batchId);

      expect(batch).toMatchObject({
        status: 'Completed',
        jobs: [{ status: 'Completed', externalId: STUB.baseGame.externalId, gameTitle: STUB.baseGame.title }],
      });

      gameId = batch.jobs[0].gameId;
      await expect(readGame(stack.baseUrl, current, required(gameId, 'game'))).resolves.toMatchObject({
        id: gameId,
        title: STUB.baseGame.title,
      });
    });

    it('finds the imported game over Socket.IO, now in the system', async () => {
      const id = required(gatewayId, 'gateway');
      const { events } = await searchGatewayOverSocket(stack.baseUrl, required(session, 'session'), id, STUB.query);

      const games = events.flatMap(({ event, payload }) => {
        const result = payload as { source: string; games: unknown[] };
        return event === 'search:result' && result.source === id ? result.games : [];
      });

      expect(events.filter(({ event }) => SOCKET_FAILURES.has(event))).toEqual([]);
      expect(games).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ...STUB.baseGame, inSystem: true, gameId: required(gameId, 'game') }),
        ]),
      );
    });
  });

  describe('the bundled web client, in Chromium', () => {
    let browser: Browser | undefined;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    // On the web, the client takes its server from its own origin: it reads
    // the identity document and opens its database for that server. Only a
    // boot that has done both settles on the sign-in screen, at /auth; one
    // that failed settles on /error.
    it("boots from the api's origin: it reads the identity document and opens its database", async () => {
      const identity = (await (await fetch(`${stack.baseUrl}/.well-known/bge-identity`)).json()) as {
        bge_server_id: string;
      };
      const visit = await visitClient(required(browser, 'browser'), stack.baseUrl, '/');

      expect(visit).toMatchObject({ documentStatus: 200, identityStatus: 200, settledPath: '/auth', problems: [] });
      expect(visit.databases).toContain(driftDatabaseName(identity.bge_server_id));
    });

    it('loads the app at a deep link', async () => {
      const visit = await visitClient(required(browser, 'browser'), stack.baseUrl, '/home');

      // Signed out, so the app routes from /home to sign-in.
      expect(visit).toMatchObject({ documentStatus: 200, identityStatus: 200, settledPath: '/auth', problems: [] });
    });

    it('answers a file the build lacks with a 404, not the app', async () => {
      const response = await fetch(`${stack.baseUrl}/no-such-file.js`);

      expect(response.status).toBe(404);
    });
  });

  // A kept stack is for a look at what the steps above left, so the run skips
  // the shutdown that would stop it.
  const describeShutdown = KEEP_STACK ? describe.skip : describe;

  describeShutdown('shutdown', () => {
    const SERVICES = [...ROLES, ...GATEWAYS];

    /**
     * Each one stops before the servers it calls, which a stop of all seven at
     * once doesn't promise: they depend on nothing but Postgres and Redis. The
     * api pings the coordinator every minute and logs an error when a ping
     * fails, and the coordinator and gateway-fetch call the gateways.
     */
    const STOP_ORDER = [['api'], ['worker', 'gateway-fetch', 'coordinator'], GATEWAYS];

    it('kept every role and gateway running, with no restarts', async () => {
      const states = await Promise.all(SERVICES.map((service) => stack.state(service)));

      expect(states.map(({ service, status, restartCount }) => ({ service, status, restartCount }))).toEqual(
        SERVICES.map((service) => ({ service, status: 'running', restartCount: 0 })),
      );
    });

    // Compose sends SIGTERM and allows ten seconds before SIGKILL, whose exit
    // code is 137. Exiting 0 means each one shut down on its own.
    it('stops each one with SIGTERM, and each exits 0', async () => {
      for (const services of STOP_ORDER) {
        await stack.compose(['stop', ...services]);
      }

      const states = await Promise.all(SERVICES.map((service) => stack.state(service)));

      expect(
        states.map(({ service, status, exitCode, oomKilled }) => ({ service, status, exitCode, oomKilled })),
      ).toEqual(SERVICES.map((service) => ({ service, status: 'exited', exitCode: 0, oomKilled: false })));
    });

    // Until #638 lands, every role's first boot logs a failed read of the
    // migration ledger, which the roles expect. Nothing else may log an error,
    // or write output that is no log record, since it can't say it isn't one.
    it('logged no error, from boot to shutdown, beyond the first boot reading an empty ledger', async () => {
      const errors: string[] = [];
      for (const service of SERVICES) {
        for (const { text } of unexpectedErrors(await stack.records(service))) {
          errors.push(`${service}: ${text}`);
        }
      }

      expect(errors).toEqual([]);
    });
  });
});
