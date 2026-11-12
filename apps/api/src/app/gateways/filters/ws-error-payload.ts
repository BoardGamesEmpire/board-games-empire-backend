import { ENVELOPE_FIELDS, errorEnvelope, type ErrorEnvelope } from '@bge/i18n';
import { WsErrorEvents, type WsErrorPayload, type WsStructuredErrorPayload } from '@bge/shared';
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
 * Builds the envelope every WS error goes out in: the HTTP error envelope
 * (#1260), plus the frame it answers. A refused connection answers no frame,
 * so it carries neither `pattern` nor `correlationId`.
 */
export function wsErrorPayload(statusCode: number, message: string | string[], frame?: WsFrame): WsErrorPayload {
  return { ...errorEnvelope(statusCode, message), ...frameFields(frame) };
}

/**
 * An HTTP exception's envelope, as `renderErrorBody` renders it for the HTTP
 * filter, plus the frame it answers, so a structured exception's fields, its
 * `code` among them, read the same on both transports. The frame's `pattern`
 * and `correlationId` always come from the frame, whatever the body said
 * (#1260).
 */
export function wsExceptionPayload(envelope: ErrorEnvelope, frame: WsFrame): WsStructuredErrorPayload {
  const { statusCode, error, message } = envelope;

  return { ...besideEnvelopeAndFrame(envelope), statusCode, error, message, ...frameFields(frame) };
}

/** The fields of an exception body that the envelope and the frame supply. */
const FRAME_FIELDS: ReadonlySet<string> = new Set([...ENVELOPE_FIELDS, 'pattern', 'correlationId']);

function besideEnvelopeAndFrame(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([field]) => !FRAME_FIELDS.has(field)));
}

function frameFields(frame: WsFrame | undefined): Pick<WsErrorPayload, 'pattern' | 'correlationId'> {
  const correlationId = frame && correlationIdOf(frame.data);

  return {
    ...(frame && { pattern: frame.pattern }),
    ...(correlationId !== undefined && { correlationId }),
  };
}

/**
 * What a handshake middleware refuses a connection with. socket.io sends its
 * message, and the envelope as its `data`, to the client's `connect_error`,
 * and the client does not try to connect again on its own.
 *
 * `fields` are a structured exception's other body fields, such as its stable
 * `code`, carried as {@link wsExceptionPayload} carries them on a frame. The
 * envelope's own fields always come from the status and message.
 */
export class WsConnectionRefusal extends Error {
  readonly data: WsStructuredErrorPayload;

  constructor(statusCode: number, message: string, fields: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = WsConnectionRefusal.name;
    this.data = { ...besideEnvelopeAndFrame(fields), ...wsErrorPayload(statusCode, message) };
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
