import { WsErrorEvents, type WsErrorPayload, type WsStructuredErrorPayload } from '@bge/shared';
import type { HttpException } from '@nestjs/common';
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

/** The fields of an exception body that the envelope itself supplies. */
const ENVELOPE_FIELDS = new Set(['statusCode', 'error', 'message', 'pattern', 'correlationId']);

/**
 * The envelope for an HTTP exception, read from its body the way Nest's HTTP
 * filter sends it. A string body is the message. An object body supplies the
 * message, its own `error` label and any other fields it carries, so a
 * structured exception reads the same on both transports. The status and the
 * frame's `pattern` and `correlationId` always come from the exception and the
 * frame, whatever the body says.
 */
export function wsExceptionPayload(exception: HttpException, frame: WsFrame): WsStructuredErrorPayload {
  const response = exception.getResponse();
  const body = (typeof response === 'string' ? { message: response } : response) as Record<string, unknown>;
  const { message, error } = body;
  const fields = Object.fromEntries(Object.entries(body).filter(([field]) => !ENVELOPE_FIELDS.has(field)));

  return {
    ...fields,
    ...wsErrorPayload(exception.getStatus(), isMessage(message) ? message : exception.message, frame),
    ...(typeof error === 'string' && { error }),
  };
}

function isMessage(message: unknown): message is string | string[] {
  return (
    typeof message === 'string' ||
    (Array.isArray(message) && message.every((line): line is string => typeof line === 'string'))
  );
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
