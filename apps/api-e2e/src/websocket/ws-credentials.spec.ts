import { WsErrorEvents, type WsErrorPayload } from '@bge/shared';
import { createActors, type Actors, type SessionActor, type SessionCredentials } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import { requireBaseUrl } from '../support/e2e-env';
import { connect, nextEvent, openSocket } from '../support/socket';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/** What socket.io-client hands a `connect_error` listener for a middleware refusal. */
type ConnectError = Error & { readonly data?: WsErrorPayload };

interface SignedIn {
  readonly credentials: SessionCredentials;
  /** The `Cookie` header a browser holding this session sends. */
  readonly cookie: string;
}

const SIGN_IN_PATH = '/api/auth/sign-in/email';
const UNTRUSTED_ORIGIN = 'https://untrusted.e2e.invalid';

/** A dotted token, the shape of a signed one, whose signature is made up. */
const FORGED_TOKEN = 'forged-session-token.Zm9yZ2VkLXNpZ25hdHVyZQ';

/**
 * Which credential a socket authenticates with, on a real socket against the
 * shipped bundle (#511).
 *
 * A connection authenticates with one credential: its `auth.token`, else its
 * handshake's `Authorization` header, else its cookie, and each frame is
 * checked against that same one. The web client holds only the cookie, which
 * the browser attaches to a socket any page opens, so a cookie counts only
 * from a trusted origin.
 */
describe('WebSocket credentials', () => {
  const baseUrl = requireBaseUrl(process.env);
  const NAMESPACE = 'games/search';
  const SEARCH_START = 'search:start';

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

  const socketWith = (credentials?: Pick<SessionCredentials, 'token'>, headers?: Record<string, string>): Socket => {
    const socket = openSocket(baseUrl, NAMESPACE, credentials, headers);
    sockets.push(socket);

    return socket;
  };

  /** A second session for `actor`, as its bearer token and as the cookie a browser keeps. */
  const signIn = async (actor: SessionActor): Promise<SignedIn> => {
    const response = await fetch(`${baseUrl}${SIGN_IN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ email: actor.user.email, password: actor.password }),
    });
    const token = response.headers.get('set-auth-token');
    const cookie = response.headers
      .getSetCookie()
      .map((header) => header.split(';', 1)[0])
      .join('; ');

    if (response.status !== 200 || !token || !cookie) {
      throw new Error(`sign-in failed for ${actor.user.email}: ${response.status} ${await response.text()}`);
    }

    return { credentials: { token, headers: { Authorization: `Bearer ${token}` } }, cookie };
  };

  /**
   * Resolves once a local search the socket starts is done. Rejects naming
   * what happened if the search is refused or the socket closes first.
   */
  const searches = (socket: Socket): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const correlationId = randomUUID();
      const settle = (outcome: () => void): void => {
        socket.off('search:done', onDone);
        socket.off(WsErrorEvents.Exception, onRefused);
        socket.off(WsErrorEvents.AuthError, onRefused);
        socket.off('disconnect', onDisconnect);
        outcome();
      };
      const onDone = (frame: { correlationId?: string }): void => {
        if (frame.correlationId === correlationId) {
          settle(resolve);
        }
      };
      const onRefused = (payload: WsErrorPayload): void =>
        settle(() => reject(new Error(`Search refused: ${JSON.stringify(payload)}`)));
      const onDisconnect = (reason: string): void =>
        settle(() => reject(new Error(`Disconnected (${reason}) before the search was done`)));

      socket.on('search:done', onDone);
      socket.on(WsErrorEvents.Exception, onRefused);
      socket.on(WsErrorEvents.AuthError, onRefused);
      socket.on('disconnect', onDisconnect);
      socket.emit(SEARCH_START, { correlationId, query: 'Gloomhaven', includeLocal: true, includeExternal: false });
    });

  /**
   * The refusal as the client sees it. `active` is false once socket.io has
   * refused a connection in middleware: the client does not try again on its
   * own.
   */
  const refusalOf = async (socket: Socket) => {
    const refused = nextEvent<ConnectError>(socket, 'connect_error');
    socket.connect();
    const { message, data } = await refused;

    return { message, data, retrying: socket.active };
  };

  it('lets a token-only socket search, end to end', async () => {
    const socket = socketWith((await actors.user()).credentials);
    await connect(socket);

    await searches(socket);
  });

  describe('a cookie-only socket', () => {
    it('searches from a trusted origin', async () => {
      const { cookie } = await signIn(await actors.user());
      const socket = socketWith(undefined, { cookie, origin: baseUrl });
      await connect(socket);

      await searches(socket);
    });

    // A browser's same-origin GET carries no Origin, and socket.io's polling
    // handshake is one, so a page served by the API itself sends only this.
    it('searches from a page whose handshake carries a trusted Referer and no Origin', async () => {
      const { cookie } = await signIn(await actors.user());
      const socket = socketWith(undefined, { cookie, referer: `${baseUrl}/games` });
      await connect(socket);

      await searches(socket);
    });

    it('searches beside an Authorization header of another scheme, as a browser behind Basic auth sends', async () => {
      const { cookie } = await signIn(await actors.user());
      const socket = socketWith(undefined, { cookie, origin: baseUrl, authorization: 'Basic dXNlcjpwYXNz' });
      await connect(socket);

      await searches(socket);
    });

    it.each([
      ['an untrusted origin', { origin: UNTRUSTED_ORIGIN }],
      ['an untrusted Referer', { referer: `${UNTRUSTED_ORIGIN}/` }],
      ['no origin at all', {}],
    ])('is refused from %s on `connect_error`, without ever being accepted', async (_, origin) => {
      const { cookie } = await signIn(await actors.user());
      const socket = socketWith(undefined, { cookie, ...origin });

      expect(await refusalOf(socket)).toEqual({
        message: 'Origin missing or not trusted',
        data: { statusCode: 403, error: 'Forbidden', message: 'Origin missing or not trusted' },
        retrying: false,
      });
    });
  });

  it('refuses a forged token sent beside a live cookie, rather than authenticating through the cookie', async () => {
    const { cookie } = await signIn(await actors.user());

    // Control: the same cookie, from the same origin, connects on its own.
    const cookieOnly = socketWith(undefined, { cookie, origin: baseUrl });
    await connect(cookieOnly);

    const forged = socketWith({ token: FORGED_TOKEN }, { cookie, origin: baseUrl });

    expect(await refusalOf(forged)).toEqual({
      message: 'Session expired or invalid',
      data: { statusCode: 401, error: 'Unauthorized', message: 'Session expired or invalid' },
      retrying: false,
    });
  });

  it("refuses a frame once its connection's session is revoked, though its Authorization header names a live one", async () => {
    const user = await actors.user();
    const live = await signIn(user);
    const socket = socketWith(user.credentials, { authorization: live.credentials.headers.Authorization });
    await connect(socket);

    // Control: while both sessions are live the socket is served.
    await searches(socket);

    const signedOut = await fetch(`${baseUrl}/api/auth/sign-out`, { method: 'POST', headers: user.headers });
    expect(signedOut.status).toBe(200);
    const sessionOf = async (headers: SessionCredentials['headers']) =>
      (await fetch(`${baseUrl}/api/auth/get-session`, { headers })).json();
    expect(await sessionOf(user.headers)).toBeNull();
    expect(await sessionOf(live.credentials.headers)).toMatchObject({ user: { id: user.user.id } });

    const refused = nextEvent<WsErrorPayload>(socket, WsErrorEvents.AuthError);
    const closed = nextEvent<string>(socket, 'disconnect');

    socket.emit(SEARCH_START, { correlationId: randomUUID(), query: 'Gloomhaven', includeLocal: true });

    expect(await refused).toMatchObject({ statusCode: 401, message: 'Session expired or invalid' });
    expect(await closed).toBe('io server disconnect');
  });
});
