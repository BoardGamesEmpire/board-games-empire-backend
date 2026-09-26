import { WsErrorEvents, type WsErrorPayload } from '@bge/shared';
import { createActors, type Actors, type SessionCredentials } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Socket } from 'socket.io-client';
import { requireBaseUrl } from '../support/e2e-env';
import { connect, nextEvent, openSocket } from '../support/socket';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/** What socket.io-client hands a `connect_error` listener for a middleware refusal. */
type ConnectError = Error & { readonly data?: WsErrorPayload };

/**
 * What a WebSocket client is told when the API refuses it (#426), on a real
 * socket against the shipped bundle.
 *
 * Before #426 these reached no listener a client could know about: validation
 * failures went to `search:start:error`, the gateway's own refusals to a room
 * the socket had not joined yet, and connection refusals in a shape of their
 * own. Each refused frame below is answered on one of the two error events,
 * in one envelope. A refused connection is never accepted (#427), so it is
 * answered on socket.io's `connect_error`, with that envelope as the error's
 * `data`.
 */
describe('WebSocket error delivery', () => {
  const baseUrl = requireBaseUrl(process.env);
  const NAMESPACE = 'games/search';
  const SEARCH_START = 'search:start';
  const STILL_OPEN_AFTER_MS = 500;

  let db: TestDatabase;
  let actors: Actors;
  const sockets: Socket[] = [];

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.disconnect();
    }
  });

  afterAll(async () => {
    await db.close();
  });

  const socketFor = (credentials?: SessionCredentials): Socket => {
    const socket = openSocket(baseUrl, NAMESPACE, credentials);
    sockets.push(socket);

    return socket;
  };

  const connectedAs = async (credentials: SessionCredentials): Promise<Socket> => {
    const socket = socketFor(credentials);
    await connect(socket);

    return socket;
  };

  /** A well-formed search that asks for no source, which the handler refuses. */
  const searchOfNothing = (correlationId: string = randomUUID()) => ({
    correlationId,
    query: 'Gloomhaven',
    includeLocal: false,
    includeExternal: false,
  });

  /**
   * Proves a socket outlived its refusal. A refused socket is held open for
   * 100 ms before it is disconnected, so `socket.connected` right after the
   * error frame would pass either way. A frame answered well after that
   * window cannot.
   */
  const expectStillOpen = async (socket: Socket): Promise<void> => {
    await delay(STILL_OPEN_AFTER_MS);
    const answered = nextEvent<WsErrorPayload>(socket, WsErrorEvents.Exception);

    socket.emit(SEARCH_START, searchOfNothing());

    expect(await answered).toMatchObject({ statusCode: 400 });
  };

  describe('a refused frame', () => {
    it('reports a validation failure on `exception`, and the socket stays open', async () => {
      const socket = await connectedAs((await actors.user()).credentials);
      const refused = nextEvent<WsErrorPayload>(socket, WsErrorEvents.Exception);

      socket.emit(SEARCH_START, { correlationId: 'not-a-uuid', query: 'Gloomhaven', includeExternal: false });

      expect(await refused).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['correlationId must be a UUID'],
        pattern: SEARCH_START,
        correlationId: 'not-a-uuid',
      });
      await expectStillOpen(socket);
    });

    it("reports the gateway's own refusal on `exception`, though no search room was joined", async () => {
      const socket = await connectedAs((await actors.user()).credentials);
      const frame = searchOfNothing();
      const refused = nextEvent<WsErrorPayload>(socket, WsErrorEvents.Exception);

      socket.emit(SEARCH_START, frame);

      expect(await refused).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'At least one of includeLocal or includeExternal must be true',
        pattern: SEARCH_START,
        correlationId: frame.correlationId,
      });
      await expectStillOpen(socket);
    });
  });

  describe('a refused connection', () => {
    /**
     * The refusal as the client sees it. `active` is false once socket.io has
     * refused a connection in middleware: the client does not try again on
     * its own.
     */
    const refusalOf = async (socket: Socket) => {
      const refused = nextEvent<ConnectError>(socket, 'connect_error');
      socket.connect();
      const { message, data } = await refused;

      return { message, data, retrying: socket.active };
    };

    it('tells an anonymous session why on `connect_error`, without ever accepting it', async () => {
      const socket = socketFor((await actors.anonymous()).credentials);

      expect(await refusalOf(socket)).toEqual({
        message: 'Anonymous access not permitted',
        data: { statusCode: 403, error: 'Forbidden', message: 'Anonymous access not permitted' },
        retrying: false,
      });
    });

    it('tells a socket without a token why on `connect_error`, without ever accepting it', async () => {
      const socket = socketFor();

      expect(await refusalOf(socket)).toEqual({
        message: 'No token provided',
        data: { statusCode: 401, error: 'Unauthorized', message: 'No token provided' },
        retrying: false,
      });
    });
  });

  describe('a frame sent after its session was revoked', () => {
    it('is answered on `auth:error`, and the socket is disconnected', async () => {
      const user = await actors.user();
      const socket = await connectedAs(user.credentials);

      // Control: while the session is live the same frame is refused only for
      // asking for no source, so the 401 below is the revocation's doing.
      const whileLive = nextEvent<WsErrorPayload>(socket, WsErrorEvents.Exception);
      socket.emit(SEARCH_START, searchOfNothing());
      expect(await whileLive).toMatchObject({ statusCode: 400 });

      const signedOut = await fetch(`${baseUrl}/api/auth/sign-out`, { method: 'POST', headers: user.headers });
      expect(signedOut.status).toBe(200);
      const session = await fetch(`${baseUrl}/api/auth/get-session`, { headers: user.headers });
      expect(await session.json()).toBeNull();

      const frame = searchOfNothing();
      const refused = nextEvent<WsErrorPayload>(socket, WsErrorEvents.AuthError);
      const closed = nextEvent<string>(socket, 'disconnect');

      socket.emit(SEARCH_START, frame);

      expect(await refused).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized',
        pattern: SEARCH_START,
        correlationId: frame.correlationId,
      });
      expect(await closed).toBe('io server disconnect');
    });
  });
});
