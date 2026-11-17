import type { PluginGrant } from '@bge/database';
import type { ConsentActDecision } from './plugin-consent-act.types';

/*
 * Whether a consent act would change a consent decision, shared by the
 * household and user act, the server act and `writeConsentAct` (#1150, #1336,
 * #1152). Pure: each act reads its standing rows under its own plugin-row
 * claim, and `writeConsentAct` writes the decisions.
 */

/** The row already holds this decision: same status, same risk. */
export function decisionStands(decision: ConsentActDecision, row: PluginGrant | null | undefined): boolean {
  return row != null && row.status === decision.status && row.decidedRiskLevel === decision.decidedRiskLevel;
}

/** Every planned decision already stands at the unit's coordinates. */
export function decisionsStand(
  decisions: readonly ConsentActDecision[],
  standingBySlug: ReadonlyMap<string, PluginGrant>,
): boolean {
  return decisions.every((decision) => decisionStands(decision, standingBySlug.get(decision.permissionSlug)));
}
