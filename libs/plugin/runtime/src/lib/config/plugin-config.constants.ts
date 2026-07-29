/**
 * Redis pub/sub channel for plugin server-scope config hot-reload. Follows
 * the SafeHttpPolicy hot-reload placement: the channel lives on the cache
 * Redis database, alongside the state it invalidates, so a `FLUSHDB` of the
 * cache implicitly resets pending invalidation messages.
 *
 * Publishing happens post-commit from the lifecycle listener when a
 * `PluginConfigUpdatedEvent` lands — publish-on-mutation without every
 * future config-mutating service needing its own publish call.
 */
export const PLUGIN_CONFIG_UPDATE_CHANNEL = 'plugin_config.updated';

/**
 * Cadence for the periodic snapshot-refresh backstop. Pub/sub refreshes
 * immediately on every config change; this timer only recovers from a
 * message missed during a transient Redis disconnect, so a coarse interval
 * is appropriate. Requires `ScheduleModule.forRoot()` in the host app for
 * the `@Interval` to fire; elsewhere the decorator is inert.
 */
export const PLUGIN_CONFIG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Named identifier for the refresh interval (SchedulerRegistry lookup). */
export const PLUGIN_CONFIG_REFRESH_INTERVAL_NAME = 'plugin-config-refresh';
