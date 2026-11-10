import {
  isPluginServing,
  isPluginUnitServed,
  judgeConsentDecision,
  PluginGrantScope,
  PluginGrantStatus,
  requestedByManifest,
  type PermissionRuleColumns,
  type PluginGrant,
  type PluginRequestedPermissionsReader,
  type Prisma,
  type RiskLevel,
} from '@bge/database';

/** The columns of a permission that decide whether a consent decision on it confers anything. */
export type ConsentEffectColumns = PermissionRuleColumns & {
  readonly slug: string;
  readonly riskLevel: RiskLevel;
  readonly retiredAt: Date | null;
};

/** A plugin's consent decision on a core permission, as far as conferring goes. */
export type ConsentDecision = Pick<PluginGrant, 'scopeType' | 'decidedRiskLevel' | 'status'>;

/**
 * How many consent decisions an edit stops conferring (#772): those `Granted`
 * that confer the permission as `before` has it and not as `after` has it.
 *
 * An edit is never refused for this. A plugin's abilities are read with every
 * consent decision checked again against the permission as it stands, on
 * every resolution, so a decision the edit outruns fails closed by itself.
 * The count is for the Owner, who sees in the response what the edit took
 * from plugins.
 *
 * A decision confers when it is granted, the permission is not retired, and
 * `judgeConsentDecision` finds it confers: the per-decision checks
 * `PermissionsService` applies when it reads a plugin's grants, shared from
 * `@bge/database` so the two cannot disagree.
 */
export function countConsentDecisionsLost(
  before: ConsentEffectColumns,
  after: ConsentEffectColumns,
  decisions: readonly ConsentDecision[],
): number {
  return decisions.filter((decision) => confers(before, decision) && !confers(after, decision)).length;
}

function confers(permission: ConsentEffectColumns, decision: ConsentDecision): boolean {
  return (
    decision.status === PluginGrantStatus.Granted &&
    permission.retiredAt === null &&
    judgeConsentDecision(permission, decision) === 'confers'
  );
}

/**
 * The `Granted` decisions on `permissionSlug` that are in force today (#772),
 * for {@link countConsentDecisionsLost} to judge against the permission. A
 * decision of a plugin that serves no one confers nothing whatever the edit
 * does, so counting it would overstate what the edit took.
 *
 * It applies the rules `PermissionsService.getPluginGrantSnapshot` applies
 * before it looks at the permission, through the predicates `@bge/database`
 * shares with that read, so the two cannot disagree:
 *
 * - The plugin is enabled and not uninstalled (`isPluginServing`).
 * - A household or user decision's unit serves the plugin: its enablement row
 *   exists, is enabled and, for a household, is not dormant
 *   (`isPluginUnitServed`). A server decision has no enablement row and is
 *   read for every unit.
 * - The plugin's active manifest, re-validated by the runtime's reader,
 *   requests the permission at the decision's scope (`requestedByManifest`).
 *   A manifest that fails re-validation rejects the plugin's whole ability, so
 *   none of its decisions are in force, and in a process with no reader none
 *   confers.
 *
 * Read in three queries, not one per unit: a plugin many households use holds
 * a decision for each, and this runs under the permission catalog's edit lock.
 */
export async function loadConsentDecisionsInForce(
  db: Pick<Prisma.TransactionClient, 'pluginGrant' | 'householdPlugin' | 'userPlugin'>,
  permissionSlug: string,
  reader: PluginRequestedPermissionsReader | undefined,
): Promise<ConsentDecision[]> {
  if (reader === undefined) {
    return [];
  }

  const stored = await db.pluginGrant.findMany({
    where: { permissionSlug, status: PluginGrantStatus.Granted },
    select: {
      pluginId: true,
      scopeType: true,
      scopeId: true,
      decidedRiskLevel: true,
      status: true,
      plugin: { select: { slug: true, version: true, manifestJson: true, enabled: true, uninstalledAt: true } },
    },
  });

  // Each plugin's manifest is read once, however many decisions it holds.
  const boundByPlugin = new Map<string, ReturnType<typeof requestedByManifest> | null>();
  const requested = (decision: (typeof stored)[number]): boolean => {
    let bound = boundByPlugin.get(decision.pluginId);
    if (bound === undefined) {
      const { slug, version, manifestJson } = decision.plugin;
      const result = reader.read({ slug, version, manifestJson });
      bound = result.valid ? requestedByManifest(result.requested) : null;
      boundByPlugin.set(decision.pluginId, bound);
    }
    return bound?.({ scopeType: decision.scopeType, permissionSlug }) ?? false;
  };

  const pluginServed = stored.filter((decision) => isPluginServing(decision.plugin) && requested(decision));

  const servedUnits = await loadServedUnits(db, pluginServed);

  return pluginServed
    .filter(
      ({ scopeType, scopeId, pluginId }) =>
        scopeType === PluginGrantScope.Server || servedUnits.has(unitKey(scopeType, scopeId, pluginId)),
    )
    .map(({ scopeType, decidedRiskLevel, status }) => ({ scopeType, decidedRiskLevel, status }));
}

/** The household and user units among `decisions` whose enablement row serves the decision's plugin. */
async function loadServedUnits(
  db: Pick<Prisma.TransactionClient, 'householdPlugin' | 'userPlugin'>,
  decisions: readonly Pick<PluginGrant, 'pluginId' | 'scopeType' | 'scopeId'>[],
): Promise<ReadonlySet<string>> {
  const at = (scopeType: PluginGrantScope) => decisions.filter((decision) => decision.scopeType === scopeType);
  const households = at(PluginGrantScope.Household);
  const users = at(PluginGrantScope.User);
  const served = new Set<string>();

  if (households.length > 0) {
    const rows = await db.householdPlugin.findMany({
      where: {
        householdId: { in: [...new Set(households.map(({ scopeId }) => scopeId))] },
        pluginId: { in: [...new Set(households.map(({ pluginId }) => pluginId))] },
      },
      select: { householdId: true, pluginId: true, enabled: true, dormantReason: true },
    });
    for (const row of rows) {
      if (isPluginUnitServed(row)) {
        served.add(unitKey(PluginGrantScope.Household, row.householdId, row.pluginId));
      }
    }
  }

  if (users.length > 0) {
    const rows = await db.userPlugin.findMany({
      where: {
        userId: { in: [...new Set(users.map(({ scopeId }) => scopeId))] },
        pluginId: { in: [...new Set(users.map(({ pluginId }) => pluginId))] },
      },
      select: { userId: true, pluginId: true, enabled: true },
    });
    for (const row of rows) {
      // The user axis has no dormancy, as `loadPluginUnitEnablement` reads it.
      if (isPluginUnitServed({ ...row, dormantReason: null })) {
        served.add(unitKey(PluginGrantScope.User, row.userId, row.pluginId));
      }
    }
  }

  return served;
}

/** NUL cannot appear in an id, so two units cannot share a key. */
function unitKey(scopeType: PluginGrantScope, scopeId: string, pluginId: string): string {
  return `${scopeType}\u0000${scopeId}\u0000${pluginId}`;
}
