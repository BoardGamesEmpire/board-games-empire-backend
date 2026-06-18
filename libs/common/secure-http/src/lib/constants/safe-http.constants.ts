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
 * Cadence for the periodic snapshot-refresh backstop. The Redis pub/sub
 * subscription refreshes immediately on every policy change; this timer only
 * exists to recover from a pub/sub message missed during a transient Redis
 * disconnect, so a coarse interval is appropriate. Requires
 * `ScheduleModule.forRoot()` in the host app for the `@Interval` to fire.
 */
export const SAFE_HTTP_POLICY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Named identifier for the refresh interval, for lookup/management via
 * `SchedulerRegistry` if ever needed.
 */
export const SAFE_HTTP_POLICY_REFRESH_INTERVAL_NAME = 'safe-http-policy-refresh';

/**
 * Fallback defaults used when the singleton `SafeHttpPolicy` row is absent
 * (pre-seed boot, fresh database) and no env override is supplied. The
 * seeded row carries the same numeric values, so steady-state these
 * constants are not consulted.
 */
export const SAFE_HTTP_DEFAULT_TIMEOUT_MS = 10_000;
export const SAFE_HTTP_DEFAULT_MAX_REDIRECTS = 5;
export const SAFE_HTTP_DEFAULT_STRICT_MODE = true;
