import { pollUntil } from '@bge/testing-e2e/poll';
import { extractSessionToken } from '@bge/testing-e2e/signup';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

/**
 * The api as a client meets it: plain HTTP and Socket.IO against the
 * published port, with the session token the sign-in hands back. Nothing
 * here imports the api's code.
 */

export interface Session {
  readonly token: string;
}

const bearer = ({ token }: Session) => ({ Authorization: `Bearer ${token}` });

async function describeResponse(response: Response): Promise<string> {
  const body = await response.text().catch(() => '<unreadable body>');
  return `${response.status} ${body.slice(0, 2000)}`;
}

async function expectOk<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${what} failed: ${await describeResponse(response)}`);
  }

  return (await response.json()) as T;
}

const SIGN_IN_PATH = '/api/auth/sign-in/email';

/**
 * Signs in through better-auth's route. Like sign-up, it carries the origin a
 * browser would send: the route refuses a request whose origin it doesn't
 * trust, and the stack trusts its own URL.
 */
export async function signIn(baseUrl: string, email: string, password: string): Promise<Session> {
  const response = await fetch(`${baseUrl}${SIGN_IN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });

  const body = await expectOk<unknown>(response, 'Signing in');
  return { token: extractSessionToken(response.headers, body, SIGN_IN_PATH) };
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
}

export async function currentUser(baseUrl: string, session: Session): Promise<SessionUser | undefined> {
  const response = await fetch(`${baseUrl}/api/auth/get-session`, { headers: bearer(session) });
  const body = await expectOk<{ user: SessionUser } | null>(response, 'Reading the session');

  return body?.user;
}

export interface GatewayRegistration {
  readonly gateway: { readonly id: string; readonly enabled: boolean };
  readonly connection_attempt: boolean;
  readonly connection_response: { readonly success: boolean; readonly message?: string } | null;
}

/** How long a new account's roles may take to land: the api grants them after sign-up answers. */
const PROVISIONING_TIMEOUT_MS = 30_000;

/**
 * The api allows one client 20 requests a minute to a route, refused ones
 * included (apps/api/src/app/configuration/throttle.config.ts). Fifteen
 * attempts in the 30 seconds stay under it.
 */
const PROVISIONING_INTERVAL_MS = 2_000;

/**
 * Registers a gateway as an owner registers one (docs/DEPLOYMENT.md). The
 * first account's owner role is granted after its sign-up has answered, so
 * a 403 is retried until then: the route refuses before it writes anything.
 * A 429 is retried too.
 */
export async function registerGateway(
  baseUrl: string,
  session: Session,
  gateway: { readonly name: string; readonly connectionUrl: string; readonly connectionPort: number },
): Promise<GatewayRegistration> {
  let refusal: string | undefined;

  try {
    return await pollUntil(
      async () => {
        const response = await fetch(`${baseUrl}/api/game-gateways`, {
          method: 'POST',
          headers: { ...bearer(session), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...gateway, authType: 'None' }),
        });

        if (response.status === 403 || response.status === 429) {
          refusal = await describeResponse(response);
          return undefined;
        }

        return expectOk<GatewayRegistration>(response, 'Registering the gateway');
      },
      {
        description: 'the owner role, to register the gateway',
        timeoutMs: PROVISIONING_TIMEOUT_MS,
        intervalMs: PROVISIONING_INTERVAL_MS,
      },
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}. The last refusal: ${refusal ?? 'none'}`, { cause: error });
  }
}

/** A game as a search reports it, by source. */
export interface SearchHit {
  readonly externalId: string;
  readonly title: string;
  readonly contentType: string;
  readonly inSystem: boolean;
  readonly gameId?: string;
}

export interface SearchResponse {
  readonly resultsBySource: Readonly<Record<string, readonly SearchHit[]>>;
  readonly errors?: Readonly<Record<string, { readonly message: string }>>;
}

/** A search of one gateway only, over HTTP. The api caches the answer per URL for a few minutes. */
export async function searchGateway(
  baseUrl: string,
  session: Session,
  gatewayId: string,
  query: string,
): Promise<SearchResponse> {
  const params = new URLSearchParams({ query, gatewayIds: gatewayId, includeLocal: 'false' });
  const response = await fetch(`${baseUrl}/api/games/search?${params}`, { headers: bearer(session) });

  return expectOk(response, 'Searching');
}

export interface SocketSearch {
  readonly events: readonly { readonly event: string; readonly payload: unknown }[];
}

/**
 * The same search over Socket.IO, as the web client runs it: results arrive
 * as events, one per gateway hit, and `search:done` ends the search.
 */
export async function searchGatewayOverSocket(
  baseUrl: string,
  session: Session,
  gatewayId: string,
  query: string,
  timeoutMs = 30_000,
): Promise<SocketSearch> {
  const socket = io(`${baseUrl}/games/search`, {
    transports: ['websocket'],
    auth: { token: session.token },
    reconnection: false,
  });

  const events: { event: string; payload: unknown }[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No search:done within ${timeoutMs / 1000}s; received ${JSON.stringify(events)}`)),
        timeoutMs,
      );
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        outcome();
      };

      socket.on('connect_error', (error: Error & { data?: unknown }) =>
        settle(() =>
          reject(new Error(`The search socket refused the connection: ${error.message} ${JSON.stringify(error.data)}`)),
        ),
      );
      // A dropped connection fails the search at once, naming why. After
      // `search:done`, the close below lands here too, on a settled promise.
      socket.on('disconnect', (reason: string) =>
        settle(() =>
          reject(
            new Error(
              `The search socket disconnected (${reason}) before search:done; received ${JSON.stringify(events)}`,
            ),
          ),
        ),
      );
      socket.onAny((event: string, payload: unknown) => {
        events.push({ event, payload });
        if (event === 'search:done') {
          settle(resolve);
        }
      });
      socket.on('connect', () => {
        socket.emit('search:start', {
          correlationId: randomUUID(),
          query,
          gatewayIds: [gatewayId],
          includeLocal: false,
        });
      });
    });
  } finally {
    socket.close();
  }

  return { events };
}

export interface ImportStarted {
  readonly batchId: string;
}

export interface ImportJob {
  readonly status: string;
  readonly externalId: string;
  readonly gameId?: string;
  readonly gameTitle?: string;
  readonly errorCode?: string;
  readonly error?: string;
}

export interface ImportBatch {
  readonly status: string;
  readonly jobs: readonly ImportJob[];
}

export async function startImport(
  baseUrl: string,
  session: Session,
  gatewayId: string,
  externalId: string,
): Promise<ImportStarted> {
  const response = await fetch(`${baseUrl}/api/games/import`, {
    method: 'POST',
    headers: { ...bearer(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({ correlationId: randomUUID(), gatewayId, externalId }),
  });

  return expectOk(response, 'Starting the import');
}

/** The statuses an import batch ends in. */
const SETTLED = new Set(['Completed', 'PartiallyCompleted', 'Failed', 'Cancelled']);

/**
 * Inside the suite's two-minute test timeout, with the import's start, so an
 * import that never settles fails here, naming its batch, and not as Jest's
 * timeout.
 */
const IMPORT_TIMEOUT_MS = 90_000;

/**
 * Polls an import until it settles. Every three seconds at most: the api lets
 * one client make 20 requests a minute to a route, and a 429 here only means
 * to ask again later.
 */
export async function awaitImport(baseUrl: string, session: Session, batchId: string): Promise<ImportBatch> {
  let last: ImportBatch | undefined;

  try {
    return await pollUntil(
      async () => {
        const response = await fetch(`${baseUrl}/api/games/import/${batchId}`, { headers: bearer(session) });
        if (response.status === 429) {
          return undefined;
        }

        last = await expectOk<ImportBatch>(response, 'Reading the import');
        return SETTLED.has(last.status) ? last : undefined;
      },
      { description: `import batch ${batchId} to settle`, timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 3_000 },
    );
  } catch (error) {
    const state = last === undefined ? 'never read' : JSON.stringify(last);
    throw new Error(`${(error as Error).message}. The batch as last read: ${state}`, { cause: error });
  }
}

export async function readGame(
  baseUrl: string,
  session: Session,
  gameId: string,
): Promise<{ readonly id: string; readonly title: string }> {
  const response = await fetch(`${baseUrl}/api/games/${gameId}`, { headers: bearer(session) });

  return (await expectOk<{ game: { id: string; title: string } }>(response, 'Reading the game')).game;
}
