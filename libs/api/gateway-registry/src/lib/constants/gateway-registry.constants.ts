/**
 * Redis pub/sub channel for gateway config updates. Any process running
 * GatewayRegistryService subscribes; coordinator-side state writes publish.
 */
export const GATEWAY_CONFIG_UPDATE_CHANNEL = 'bge:gateway:config-updated';

/**
 * Threshold of consecutive call failures within FAILURE_WINDOW_MS that
 * triggers automatic gateway disable + admin notification.
 *
 * Tuned conservatively — 3 is enough to distinguish a real outage from
 * transient blips while keeping disable responsive.
 */
export const FAILURE_THRESHOLD = 3;

/**
 * Sliding window for consecutive-failure tracking. After this duration
 * since the first tracked failure, the counter resets on the next
 * failure even if intervening calls succeeded.
 */
export const FAILURE_WINDOW_MS = 5 * 60 * 1000;

/**
 * EventEmitter2 event name emitted when a gateway is auto-disabled due
 * to repeated failures. Listeners should create admin-facing notifications.
 */
export const GATEWAY_DISABLED_EVENT = 'gateway.disabled';
