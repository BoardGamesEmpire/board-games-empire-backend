/**
 * RESERVED — inbound topic event envelope (#196).
 *
 * Declared in the contract now so the `GameGatewayDriver.handleInbound?` slot
 * is stable for driver authors, but the shape is a stub: #196 owns its final
 * definition (topic naming, payload schema versioning, delivery metadata).
 * Treat every field as provisional until that issue lands.
 */
export interface GatewayInboundEvent {
  /**
   * Manifest-declared topic name, e.g. `igdb.game.updated`.
   */
  topic: string;

  /**
   * Upstream entity identifier, when the event concerns a single entity.
   */
  externalId?: string;

  /**
   * Upstream change classification.
   */
  kind: 'created' | 'updated' | 'deleted';

  /**
   * Raw upstream payload. Unexpanded by contract — treat as a change signal,
   * not a source of truth (see #196: content refresh re-fetches).
   */
  payload: unknown;

  /**
   * When the host ingress accepted the delivery.
   */
  receivedAt: Date;
}
