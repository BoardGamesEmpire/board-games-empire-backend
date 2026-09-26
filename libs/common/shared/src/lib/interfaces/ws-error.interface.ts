/**
 * The two events every gateway reports errors on, split by what the client
 * should do next (#426).
 */
export enum WsErrorEvents {
  /**
   * The connection is closing because of who the client is: a refused
   * connection, or a frame whose session is gone. The socket disconnects
   * right after.
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
 * The payload of both {@link WsErrorEvents}: Nest's HTTP error body, so one
 * client parser reads either transport, plus the frame the error answers.
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
