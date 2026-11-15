import type { HouseholdPlugin, PluginGrant, UserPlugin } from '@bge/database';

/**
 * What a plugin event carries of the row it is about, one copy of each shape
 * (#1150). A consent act, the unit lifecycle, a server decision and an update
 * all announce consent decisions and switches, and a field added to one
 * writer's snapshot and not another's would make the same transition read
 * differently depending on who wrote it.
 */

/** A consent decision, as the grant created, rejected and revoked events carry it. */
export function grantSnapshot(row: PluginGrant) {
  const { id, pluginId, scopeType, scopeId, permissionSlug, status, decidedRiskLevel } = row;

  return { id, pluginId, scopeType, scopeId, permissionSlug, status, decidedRiskLevel };
}

/** A household's unit enablement, as its switch events and the re-consent announcement carry it. */
export function householdSwitchSnapshot(row: HouseholdPlugin) {
  const { id, householdId, pluginId, enabled } = row;

  return { id, householdId, pluginId, enabled };
}

/** A user's unit enablement, as its switch events and the re-consent announcement carry it. */
export function userSwitchSnapshot(row: UserPlugin) {
  const { id, userId, pluginId, enabled } = row;

  return { id, userId, pluginId, enabled };
}

/**
 * A household's unit enablement, as the dormancy events carry it: the switch
 * fields plus the reason, so a diff shows what moved and what deliberately did
 * not. Activation's dormancy pass and a consent act that lifts a configuration
 * dormancy (#1150) both announce with it.
 */
export function householdDormancySnapshot(row: HouseholdPlugin) {
  const { id, householdId, pluginId, enabled, dormantReason } = row;

  return { id, householdId, pluginId, enabled, dormantReason };
}
