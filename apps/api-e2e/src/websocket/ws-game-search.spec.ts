import { Visibility } from '@bge/database';
import { WsErrorEvents, type WsErrorPayload } from '@bge/shared';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import { requireBaseUrl } from '../support/e2e-env';
import { connect, openSocket } from '../support/socket';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

interface LocalHit {
  readonly gameId?: string;
}

interface SearchFrame {
  readonly correlationId: string;
  readonly source?: string;
  readonly games?: readonly LocalHit[];
}

/**
 * Game search over a real socket against the shipped bundle (#427, #498).
 *
 * Each frame runs as the actor its connection authenticated as, with that
 * actor's abilities primed, and the local half reads through them. These are
 * the WebSocket mirror of the REST search case in `game-authorization.spec.ts`:
 * with the priming removed, the creator's frame is refused and the privacy
 * case fails.
 *
 * External gateways are left out: this suite runs no coordinator, and the
 * local half is the one that reads the Game table.
 */
describe('game search over WebSocket', () => {
  const baseUrl = requireBaseUrl(process.env);
  const NAMESPACE = 'games/search';
  const SEARCH_START = 'search:start';
  const SEARCH_TIMEOUT_MS = 10_000;

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

  const socketFor = (actor: AuthenticatedActor): Socket => {
    const socket = openSocket(baseUrl, NAMESPACE, actor.credentials);
    sockets.push(socket);

    return socket;
  };

  const connectedAs = async (actor: AuthenticatedActor): Promise<Socket> => {
    const socket = socketFor(actor);
    await connect(socket);

    return socket;
  };

  const arrangeGame = (createdById: string, visibility: Visibility, title: string) =>
    db.client.game.create({ data: { title, visibility, createdById }, select: { id: true } });

  const localSearchFor = (query: string) => ({
    correlationId: randomUUID(),
    query,
    includeLocal: true,
    includeExternal: false,
  });

  /**
   * The ids of the local games a search found, once its `search:done`
   * arrives. Rejects on an error frame for the search, or a refused
   * connection, naming it, so a failed search cannot pass as one that found
   * nothing, and names what did arrive if the search never ends. Removes its
   * listeners and its timer however it settles.
   */
  const localHitsOf = (socket: Socket, correlationId: string): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const ids: string[] = [];
      const received: string[] = [];
      const ours = (frame: { correlationId?: string }) => frame.correlationId === correlationId;

      const onAny = (event: string) => received.push(event);
      const onResult = (frame: SearchFrame) => {
        if (ours(frame) && frame.source === 'local') {
          ids.push(...(frame.games ?? []).map((hit) => hit.gameId ?? '<a local hit with no gameId>'));
        }
      };
      const onError = (frame: SearchFrame) => {
        if (ours(frame)) {
          fail(`search:error for the search: ${JSON.stringify(frame)}`);
        }
      };
      const onRefused = (payload: WsErrorPayload) => {
        if (ours(payload)) {
          fail(`Frame refused: ${JSON.stringify(payload)}`);
        }
      };
      const onConnectError = (error: Error) => fail(`Connection refused: ${error.message}`);
      const onDone = (frame: SearchFrame) => {
        if (ours(frame)) {
          settle();
          resolve(ids);
        }
      };

      const settle = () => {
        clearTimeout(timer);
        socket.offAny(onAny);
        socket.off('search:result', onResult);
        socket.off('search:error', onError);
        socket.off(WsErrorEvents.Exception, onRefused);
        socket.off('connect_error', onConnectError);
        socket.off('search:done', onDone);
      };
      const fail = (message: string) => {
        settle();
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail(`No search:done within ${SEARCH_TIMEOUT_MS}ms; received [${received.join(', ')}]`),
        SEARCH_TIMEOUT_MS,
      );

      socket.onAny(onAny);
      socket.on('search:result', onResult);
      socket.on('search:error', onError);
      socket.on(WsErrorEvents.Exception, onRefused);
      socket.on('connect_error', onConnectError);
      socket.on('search:done', onDone);
    });

  const search = async (socket: Socket, query: string): Promise<string[]> => {
    const frame = localSearchFor(query);
    const hits = localHitsOf(socket, frame.correlationId);
    socket.emit(SEARCH_START, frame);

    return (await hits).sort();
  };

  it('answers a search sent before its connection is accepted', async () => {
    const user = await actors.user();
    const token = randomUUID().slice(0, 8);
    const game = await arrangeGame(user.user.id, Visibility.Public, `WS early ${token}`);

    const socket = socketFor(user);
    const frame = localSearchFor(token);
    const hits = localHitsOf(socket, frame.correlationId);

    // socket.io-client holds a frame emitted before the connection is
    // accepted and sends it the moment it is.
    socket.connect();
    socket.emit(SEARCH_START, frame);

    expect(await hits).toEqual([game.id]);
  });

  it('finds a private game for its creator only', async () => {
    const creator = await actors.user();
    const other = await actors.user();

    const token = randomUUID().slice(0, 8);
    const privateGame = await arrangeGame(creator.user.id, Visibility.Private, `WS search ${token} private`);
    const publicGame = await arrangeGame(creator.user.id, Visibility.Public, `WS search ${token} public`);

    const [mine, theirs] = await Promise.all([connectedAs(creator), connectedAs(other)]);

    expect(await search(mine, token)).toEqual([privateGame.id, publicGame.id].sort());

    // The control is the Public hit: the search ran and matched for this user.
    expect(await search(theirs, token)).toEqual([publicGame.id]);
  });
});
