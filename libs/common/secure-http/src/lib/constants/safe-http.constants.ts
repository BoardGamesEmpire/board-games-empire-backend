/**
 * Redis pub/sub channel for SafeHttpPolicy hot-reload. The admin controller
 * publishes here after persisting changes to the singleton row; every
 * process running `SafeHttpPolicyService` subscribes and refreshes its
 * in-memory snapshot.
 *
 * Channel lives on the cache Redis database, alongside the analogous
 * gateway config channel — they share invalidation semantics (a `FLUSHDB`
 * of the cache implicitly resets pending invalidation messages).
 */
export const SAFE_HTTP_POLICY_UPDATE_CHANNEL = 'safe_http.policy_updated';

/**
 * EventEmitter2 event emitted in-process after the snapshot has been
 * refreshed. Consumers that want to react in the same process (e.g.
 * clearing a per-host counter cache) listen for this rather than the Redis
 * channel.
 */
export const SAFE_HTTP_POLICY_UPDATED_EVENT = 'safe_http.policy_updated';

/**
 * Fallback defaults used when the singleton `SafeHttpPolicy` row is absent
 * (pre-seed boot, fresh database) and no env override is supplied. The
 * seeded row carries the same numeric values, so steady-state these
 * constants are not consulted.
 */
export const SAFE_HTTP_DEFAULT_TIMEOUT_MS = 10_000;
export const SAFE_HTTP_DEFAULT_MAX_REDIRECTS = 5;
export const SAFE_HTTP_DEFAULT_STRICT_MODE = true;
