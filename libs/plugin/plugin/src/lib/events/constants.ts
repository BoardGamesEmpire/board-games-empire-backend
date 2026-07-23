/**
 * Lifecycle event names for the plugin subsystem (#59). Values are the
 * EventEmitter2 routing keys; classes in `plugin.events.ts` carry them as
 * `static readonly eventName` per the emit-site convention (#57).
 *
 * NOTE: `plugin.config_updated` is intentionally shared by TWO classes —
 * `PluginConfigUpdatedEvent` (server-scope `Plugin.config`) and
 * `HouseholdPluginConfigUpdatedEvent` (per-household `HouseholdPlugin.config`).
 * Listeners that care about the distinction discriminate on `instanceof`
 * (or `subject`), not on the routing key.
 */
export enum PluginEvent {
  Installed = 'plugin.installed',
  Enabled = 'plugin.enabled',
  Disabled = 'plugin.disabled',
  Uninstalled = 'plugin.uninstalled',
  ConfigUpdated = 'plugin.config_updated',
  UpdateCheckCompleted = 'plugin.update_check_completed',
  UpdatePending = 'plugin.update_pending',
  UpdateApproved = 'plugin.update_approved',
  UpdateRejected = 'plugin.update_rejected',
  LoadFailed = 'plugin.load_failed',
  GrantCreated = 'plugin.grant_created',
  GrantRejected = 'plugin.grant_rejected',
  UnitDisabled = 'plugin.unit_disabled',
}

/**
 * Wildcard for the Phase B lifecycle listener (dedicated
 * `plugin_lifecycle_events` writes, D-A). Also matches plugin-EMITTED
 * domain events (`plugin.<slug>.*`, #59 events.emits namespace), so the
 * listener must filter on `instanceof MutationEvent` subclasses from this
 * lib rather than trusting the routing key alone.
 */
export const PLUGIN_EVENT_WILDCARD = 'plugin.**' as const;
