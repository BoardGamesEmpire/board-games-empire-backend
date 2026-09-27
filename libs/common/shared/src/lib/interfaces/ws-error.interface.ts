/**
 * The two events every gateway reports errors on once it has accepted a
 * connection, split by what the client should do next (#426).
 *
 * A refused connection is never accepted, so it hears on neither: socket.io
 * answers it on the client's `connect_error`, with the same envelope as the
 * error's `data` (#427). A 500 there says the server could not check the
 * session at all, so connecting again may succeed.
 */
export enum WsErrorEvents {
  /**
   * The connection is closing, and the socket disconnects right after: a
   * frame arrived whose session is gone.
   */
  AuthError = 'auth:error',

  /**
   * One frame was refused and the connection stays open: a validation
   * failure, a refusal by the handler, a frame the client may not send, or an
   * unexpected server error. It is also the event Nest sends an unfiltered
   * exception on, so nothing that escapes a gateway's filter lands elsewhere.
   */
  Exception = 'exception',
}

/**
 * The payload of both {@link WsErrorEvents}, and the `data` of a refused
 * connection's `connect_error`: Nest's HTTP error body, so one client parser
 * reads either transport, plus the frame the error answers. The payload for a
 * structured exception also carries its body's other fields
 * ({@link WsStructuredErrorPayload}).
 */
export interface WsErrorPayload {
  readonly statusCode: number;

  /**
   * The HTTP body's `error` field: the status text, or a structured
   * exception's own label.
   */
  readonly error: string;

  /** A list for validation failures, as over HTTP. */
  readonly message: string | string[];

  /** The pattern the refused frame was sent on. Absent for a refused connection. */
  readonly pattern?: string;

  /**
   * The refused frame's `correlationId`, echoed when it carried a string one,
   * so a client can tell which of its searches was refused. A validation
   * failure can be about the id itself, so it is echoed as sent.
   */
  readonly correlationId?: string;
}

/**
 * A {@link WsErrorPayload} that also carries the other fields of a structured
 * exception's body, as over HTTP: a quota refusal's `resource`, `scope` and
 * `limit`, or a deadlock's `code` and `retryable`. Kept apart so the envelope
 * itself still refuses a misspelt field.
 */
export interface WsStructuredErrorPayload extends WsErrorPayload {
  readonly [field: string]: unknown;
}
