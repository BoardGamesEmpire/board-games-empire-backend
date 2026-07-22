/**
 * Event published to Redis pub/sub when a gateway's configuration changes
 * in a way that affects connection behavior. Subscribers compare configHash
 * against their cached version to decide whether to invalidate.
 */
export interface GatewayConfigEvent {
  gatewayId: string;

  /**
   * Hash of the new config — receivers compare against their cached hash
   */
  configHash: string;

  /**
   * Categorical change type — informational for listeners
   */
  changeType: 'created' | 'updated' | 'deleted' | 'disabled' | 'reconnect-requested';

  /**
   * Timestamp in milliseconds since epoch
   */
  timestamp: number;
}

// The EventEmitter2 auto-disable payload moved to a MutationEvent class:
// see `../events/gateway-registry.events` (#57 emit-site migration).
