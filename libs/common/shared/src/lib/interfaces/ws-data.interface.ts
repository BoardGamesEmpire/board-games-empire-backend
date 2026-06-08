/**
 * Shape stored on `Socket.data` by the AuthenticatedGateway base class and
 * consumed by `WsActorInterceptor` to populate CLS per WS message.
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
}
