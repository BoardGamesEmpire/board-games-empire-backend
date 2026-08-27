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
 * `plugin.unit_dormant` / `plugin.unit_revived` are deliberately NOT folded
 * into `unit_disabled`/`unit_enabled`: those two mean consent suspension and
 * late acceptance, and their payloads are permission slugs. Dormancy is a
 * different cause with no slugs (#369, #370, D-CK), so a listener filtering
 * for consent transitions must not have to inspect a payload to tell them
 * apart.
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
  UnitDisabled = 'plugin.unit_disabled',
  UnitEnabled = 'plugin.unit_enabled',
  UnitDormant = 'plugin.unit_dormant',
  UnitRevived = 'plugin.unit_revived',
}

/**
 * Wildcard for the Phase B lifecycle listener (dedicated
 * `plugin_lifecycle_events` writes). Also matches plugin-EMITTED
 * domain events (`plugin.<slug>.*`, #59 events.emits namespace), so the
 * listener must filter on `instanceof MutationEvent` subclasses from runtime
 * rather than trusting the routing key alone.
 */
export const PLUGIN_EVENT_WILDCARD = 'plugin.**' as const;
