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

/**
 * Payload emitted on EventEmitter2 when a gateway is auto-disabled.
 * Listeners build admin notifications from this.
 */
export interface GatewayDisabledEvent {
  gatewayId: string;
  reason: 'repeated_connection_failure' | 'repeated_call_failure';
  consecutiveFailures: number;
  firstFailureAt: Date;
  lastFailureAt: Date;
  lastError: string;
}
