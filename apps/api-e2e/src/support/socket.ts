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

/** Resolves with the payload of the next `event` the socket receives. */
export function nextEvent<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onEvent = (payload: T): void => {
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`No '${event}' frame within ${EVENT_TIMEOUT_MS}ms`));
    }, EVENT_TIMEOUT_MS);

    socket.once(event, onEvent);
  });
}

/** Connects `socket` and resolves once the namespace has accepted it. */
export async function connect(socket: Socket): Promise<void> {
  const connected = nextEvent(socket, 'connect');
  socket.connect();
  await connected;
}
