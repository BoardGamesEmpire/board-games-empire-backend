import { WsErrorEvents, type WsErrorPayload } from '@bge/shared';
import { STATUS_CODES } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import type { Socket } from 'socket.io';

/**
 * How long a refused socket stays open before it is disconnected, so the
 * `auth:error` frame is flushed first. Disconnecting sooner meant clients
 * never saw the refusal; #427 records why the delay has to stay.
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

/** Tells the client why on `auth:error`, then closes the socket. */
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
