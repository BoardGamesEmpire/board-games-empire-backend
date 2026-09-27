/**
 * Shape stored on `Socket.data` by the AuthenticatedGateway base class at the
 * handshake, and read by `WsActorScope` to open each frame's CLS scope.
 *
 * `actor` is narrowed to `UserActor` because Phase 1 only permits registered,
 * non-anonymous user sessions over WebSocket. Anonymous sessions are rejected
 * at handshake; API keys are not honored over WS. When either restriction
 * loosens, widen this type accordingly.
 */
export interface BaseClientData {
  readonly actor: {
    readonly kind: 'user';
    readonly userId: string;
  };

  readonly correlationId: string;
  readonly userId: string;

  /**
   * The catalog locale the connection's copy renders in: the user's stored
   * preference, then the handshake's `Accept-Language`, then the fallback.
   * Resolved once, at the handshake, so a changed preference applies from the
   * socket's next connection (#180).
   */
  readonly locale: string;
}
