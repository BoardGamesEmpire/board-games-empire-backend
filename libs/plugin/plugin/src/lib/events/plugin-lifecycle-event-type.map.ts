import { PluginLifecycleEventType } from '@bge/database';
import { PluginEvent } from './constants.js';

/**
 * Routing key → persisted enum for the dedicated `plugin_lifecycle_events`
 * table (D-A). The Phase B listener uses this to translate an in-process
 * event into its durable row; the bijection spec keeps the EventEmitter2
 * vocabulary and the Prisma enum from drifting apart (same pattern as the
 * proto `stringEnums` alignment specs).
 */
export const PLUGIN_EVENT_TO_LIFECYCLE_TYPE: Readonly<Record<PluginEvent, PluginLifecycleEventType>> = {
  [PluginEvent.Installed]: PluginLifecycleEventType.Installed,
  [PluginEvent.Enabled]: PluginLifecycleEventType.Enabled,
  [PluginEvent.Disabled]: PluginLifecycleEventType.Disabled,
  [PluginEvent.Uninstalled]: PluginLifecycleEventType.Uninstalled,
  [PluginEvent.ConfigUpdated]: PluginLifecycleEventType.ConfigUpdated,
  [PluginEvent.UpdateCheckCompleted]: PluginLifecycleEventType.UpdateCheckCompleted,
  [PluginEvent.UpdatePending]: PluginLifecycleEventType.UpdatePending,
  [PluginEvent.UpdateApproved]: PluginLifecycleEventType.UpdateApproved,
  [PluginEvent.UpdateRejected]: PluginLifecycleEventType.UpdateRejected,
  [PluginEvent.LoadFailed]: PluginLifecycleEventType.LoadFailed,
  [PluginEvent.GrantCreated]: PluginLifecycleEventType.GrantCreated,
  [PluginEvent.GrantRejected]: PluginLifecycleEventType.GrantRejected,
  [PluginEvent.UnitDisabled]: PluginLifecycleEventType.UnitDisabled,
};
