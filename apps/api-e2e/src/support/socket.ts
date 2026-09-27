import type { SessionCredentials } from '@bge/testing-e2e';
import { io, type Socket } from 'socket.io-client';

const EVENT_TIMEOUT_MS = 10_000;

/**
 * A socket on one of the API's gateway namespaces, not yet connected, so a
 * spec can attach listeners before anything arrives: a refused connection is
 * answered the moment it opens.
 *
 * With credentials, it sends both of the ones the API reads. The connection
 * authenticates `auth.token`, and every frame is authenticated again from the
 * handshake headers (#511).
 */
export function openSocket(baseUrl: string, namespace: string, credentials?: SessionCredentials): Socket {
  return io(`${baseUrl}/${namespace}`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
    ...(credentials && { auth: { token: credentials.token }, extraHeaders: { ...credentials.headers } }),
  });
}

/**
 * Resolves with the payload of the next `event` the socket receives. Rejects
 * as soon as the socket fails to connect or disconnects first, naming why,
 * rather than at the timeout, and a spec's teardown disconnect settles any
 * wait a failed test left behind. Waiting for `connect_error` itself resolves
 * with the refusal: the error's message, and the envelope as its `data`.
 */
export function nextEvent<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (outcome: () => void): void => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off('connect_error', onConnectError);
      socket.off('disconnect', onDisconnect);
      outcome();
    };

    const onEvent = (payload: T): void => settle(() => resolve(payload));
    const onConnectError = (error: Error): void =>
      settle(() => reject(new Error(`Connection failed while waiting for '${event}': ${error.message}`)));
    const onDisconnect = (reason: string): void =>
      settle(() => reject(new Error(`Disconnected (${reason}) while waiting for '${event}'`)));

    const timer = setTimeout(
      () => settle(() => reject(new Error(`No '${event}' frame within ${EVENT_TIMEOUT_MS}ms`))),
      EVENT_TIMEOUT_MS,
    );

    socket.on(event, onEvent);
    if (event !== 'connect_error') {
      socket.on('connect_error', onConnectError);
    }
    if (event !== 'disconnect') {
      socket.on('disconnect', onDisconnect);
    }
  });
}

/** Connects `socket` and resolves once the namespace has accepted it. */
export async function connect(socket: Socket): Promise<void> {
  const connected = nextEvent(socket, 'connect');
  socket.connect();
  await connected;
}
