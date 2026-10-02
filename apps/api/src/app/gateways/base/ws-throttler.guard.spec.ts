import { type Actor, getActorSnapshotFromCls } from '@bge/actor-context';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import type { Socket } from 'socket.io';
import { createThrottlers } from '../../lib/throttlers';
import { WsThrottlerGuard } from './ws-throttler.guard';

// Keep the real `actorUserId` (pure); stub only the CLS reader.
jest.mock('@bge/actor-context', () => ({
  ...jest.requireActual('@bge/actor-context'),
  getActorSnapshotFromCls: jest.fn(),
}));

const snapshot = getActorSnapshotFromCls as jest.MockedFunction<typeof getActorSnapshotFromCls>;

const LIMIT = 2;

class SearchGateway {
  search(): void {
    // A handler the frames are addressed to.
  }

  cancel(): void {
    // Another handler on the same gateway.
  }
}

/**
 * A connected socket. Every one looks the same to the IP tier, which finds no
 * peer address on it. Its headers are on its handshake, never on the socket.
 */
const socketNamed = (id: string, userAgent = 'test-client') =>
  ({ id, handshake: { headers: { 'user-agent': userAgent } } }) as unknown as Socket;

/** The app's own tiers, so the IP tier brings its own tracker, as it does in the app. */
const appThrottlers = () =>
  createThrottlers({
    getOrThrow: <T>(key: string): T =>
      ({ 'throttle.ttlMs': 60_000, 'throttle.limit': LIMIT, 'throttle.trustedProxyHops': 0 })[key] as T,
  });

/**
 * A frame on `client`, running as `actor`. As on a real frame, the guard's
 * HTTP "request" is the socket and its "response" the frame's payload.
 */
function frame(client: Socket, actor: Actor | undefined, handler = SearchGateway.prototype.search): ExecutionContext {
  snapshot.mockReturnValue({ actor } as ReturnType<typeof getActorSnapshotFromCls>);
  const payload = { query: 'Gloomhaven' };

  return {
    getType: () => 'ws',
    getClass: () => SearchGateway,
    getHandler: () => handler,
    switchToWs: () => ({ getClient: () => client, getData: () => payload }),
    switchToHttp: () => ({ getRequest: () => client, getResponse: () => payload }),
  } as unknown as ExecutionContext;
}

const user = (userId: string): Actor => ({ kind: 'user', userId });

describe('WsThrottlerGuard', () => {
  let storage: ThrottlerStorageService;
  let guard: WsThrottlerGuard;

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    guard = new WsThrottlerGuard({ throttlers: appThrottlers() }, storage, new Reflector());
    await guard.onModuleInit();
  });

  afterEach(() => storage.onApplicationShutdown());

  /** Sends `count` frames through `through`, each of which must be let through. */
  const sendAllowed = async (count: number, context: () => ExecutionContext, through = guard) => {
    for (let sent = 0; sent < count; sent++) {
      await expect(through.canActivate(context())).resolves.toBe(true);
    }
  };

  it('refuses the frame over the limit with a 429, and sets no headers on the payload', async () => {
    const socket = socketNamed('socket-1');
    await sendAllowed(LIMIT, () => frame(socket, user('user-a')));

    // Setting headers would have called `header()` on the payload, and thrown a TypeError instead.
    const refusal = await guard.canActivate(frame(socket, user('user-a'))).catch((error) => error);

    expect(refusal).toBeInstanceOf(ThrottlerException);
    expect(refusal.getStatus()).toBe(429);
  });

  it("counts each user's frames apart, though every socket looks the same to the IP tier", async () => {
    await sendAllowed(LIMIT, () => frame(socketNamed('socket-1'), user('user-a')));
    await expect(guard.canActivate(frame(socketNamed('socket-1'), user('user-a')))).rejects.toThrow(ThrottlerException);

    await expect(guard.canActivate(frame(socketNamed('socket-2'), user('user-b')))).resolves.toBe(true);
  });

  it("counts a user's frames across all of their sockets, so reconnecting starts no new count", async () => {
    await sendAllowed(LIMIT, () => frame(socketNamed('socket-1'), user('user-a')));

    await expect(guard.canActivate(frame(socketNamed('socket-2'), user('user-a')))).rejects.toThrow(ThrottlerException);
  });

  it('counts each handler apart', async () => {
    const socket = socketNamed('socket-1');
    await sendAllowed(LIMIT, () => frame(socket, user('user-a')));

    await expect(guard.canActivate(frame(socket, user('user-a'), SearchGateway.prototype.cancel))).resolves.toBe(true);
  });

  it('counts a frame outside any actor scope against its own socket, never one bucket for all of them', async () => {
    await sendAllowed(LIMIT, () => frame(socketNamed('socket-1'), undefined));
    await expect(guard.canActivate(frame(socketNamed('socket-1'), undefined))).rejects.toThrow(ThrottlerException);

    await expect(guard.canActivate(frame(socketNamed('socket-2'), undefined))).resolves.toBe(true);
  });

  it("reads `ignoreUserAgents` from the frame's handshake, where a socket's headers are", async () => {
    const ignoring = new WsThrottlerGuard(
      { throttlers: appThrottlers(), ignoreUserAgents: [/crawler/] },
      storage,
      new Reflector(),
    );
    await ignoring.onModuleInit();
    const crawler = socketNamed('socket-1', 'friendly-crawler/1.0');
    const browser = socketNamed('socket-2');

    await sendAllowed(LIMIT + 1, () => frame(crawler, user('user-a')), ignoring);

    // Any other user agent is still counted.
    await sendAllowed(LIMIT, () => frame(browser, user('user-b')), ignoring);
    await expect(ignoring.canActivate(frame(browser, user('user-b')))).rejects.toThrow(ThrottlerException);
  });
});
