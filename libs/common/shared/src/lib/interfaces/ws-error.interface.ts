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
 * reads either transport, plus the frame the error answers.
 */
export interface WsErrorPayload {
  readonly statusCode: number;

  /** The status text, as the HTTP body's `error` field carries it. */
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
