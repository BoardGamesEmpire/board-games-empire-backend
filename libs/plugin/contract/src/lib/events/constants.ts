/**
 * Lifecycle event names for the plugin subsystem (#59). Values are the
 * EventEmitter2 routing keys; classes in runtime carry them as
 * `static readonly eventName` per the emit-site convention (#57).
 *
 * NOTE: `plugin.config_updated` is intentionally shared by TWO classes —
 * `PluginConfigUpdatedEvent` (server-scope `Plugin.config`) and
 * `HouseholdPluginConfigUpdatedEvent` (per-household `HouseholdPlugin.config`).
 * Listeners that care about the distinction discriminate on `instanceof`
 * (or `subject`), not on the routing key.
 *
 * `plugin.re_consent_requested` is likewise shared by a household and a user
 * class (#1149): it announces that an activation left a unit without
 * consent for the new manifest's re-consent slugs, and changes no unit
 * enablement.
 *
 * No event announces dormancy. Whether a household's unit can run is worked
 * out when read, from the active manifest's scope and the unit's retained
 * configuration (#1151), so there is no stored transition to announce.
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
  GrantRevoked = 'plugin.grant_revoked',
  ReconsentRequested = 'plugin.re_consent_requested',
}

/**
 * Wildcard for the Phase B lifecycle listener (dedicated
 * `plugin_lifecycle_events` writes). Also matches plugin-EMITTED
 * domain events (`plugin.<slug>.*`, #59 events.emits namespace), so the
 * listener must filter on `instanceof MutationEvent` subclasses from runtime
 * rather than trusting the routing key alone.
 */
export const PLUGIN_EVENT_WILDCARD = 'plugin.**' as const;
