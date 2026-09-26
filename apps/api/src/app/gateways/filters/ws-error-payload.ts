import { WsErrorEvents, type WsErrorPayload } from '@bge/shared';
import { STATUS_CODES } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import type { Socket } from 'socket.io';

/**
 * How long a socket whose session is gone stays open before it is
 * disconnected, so the `auth:error` frame is flushed first. Disconnecting
 * sooner meant clients never saw the refusal. A refused connection needs no
 * wait: it is refused before socket.io accepts it, on `connect_error`.
 */
const AUTH_ERROR_FLUSH_MS = 100;

/** The frame an error answers, as the exception host reports it. */
export interface WsFrame {
  readonly pattern: string;
  readonly data: unknown;
}

/**
 * Builds the envelope every WS error goes out in. A refused connection answers
 * no frame, so it carries neither `pattern` nor `correlationId`.
 */
export function wsErrorPayload(statusCode: number, message: string | string[], frame?: WsFrame): WsErrorPayload {
  const correlationId = frame && correlationIdOf(frame.data);

  return {
    statusCode,
    error: STATUS_CODES[statusCode] ?? 'Error',
    message,
    ...(frame && { pattern: frame.pattern }),
    ...(correlationId !== undefined && { correlationId }),
  };
}

/**
 * What a handshake middleware refuses a connection with. socket.io sends its
 * message, and the envelope as its `data`, to the client's `connect_error`,
 * and the client does not try to connect again on its own.
 */
export class WsConnectionRefusal extends Error {
  readonly data: WsErrorPayload;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = WsConnectionRefusal.name;
    this.data = wsErrorPayload(statusCode, message);
  }
}

/** Tells a connected client why on `auth:error`, then closes the socket. */
export async function refuseSocket(client: Socket, payload: WsErrorPayload): Promise<void> {
  client.emit(WsErrorEvents.AuthError, payload);
  await setTimeout(AUTH_ERROR_FLUSH_MS);
  client.disconnect(true);
}

function correlationIdOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const { correlationId } = data as { correlationId?: unknown };
  return typeof correlationId === 'string' ? correlationId : undefined;
}
