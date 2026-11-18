import type {
  PermissionRuleColumns,
  PluginActiveManifest,
  PluginActiveManifestReader,
  PluginGrant,
  Prisma,
  RiskLevel,
} from '@bge/database';
import {
  derivePluginUnitDormancy,
  isPluginServing,
  isPluginUnitServed,
  judgeConsentDecision,
  PluginGrantScope,
  PluginGrantStatus,
  requestedByManifest,
} from '@bge/database';

/** The columns of a permission that decide whether a consent decision on it confers anything. */
export type ConsentEffectColumns = PermissionRuleColumns & {
  readonly retiredAt: Date | null;
  readonly riskLevel: RiskLevel;
  readonly slug: string;
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
 * - A household or user decision's unit serves the plugin: its unit
 *   enablement exists and is switched on and, for a household, the dormancy
 *   rule (`derivePluginUnitDormancy`, #1151) finds no dormancy in it, judged
 *   from the active manifest and the unit enablement's `config` as stored
 *   (`isPluginUnitServed`). A server decision has no unit enablement and is
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
  reader: PluginActiveManifestReader | undefined,
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

  // Each plugin's manifest is read once, however many decisions it holds;
  // `null` when it fails re-validation.
  const boundByPlugin = new Map<string, BoundManifest | null>();
  const boundOf = (decision: (typeof stored)[number]): BoundManifest | null => {
    let bound = boundByPlugin.get(decision.pluginId);
    if (bound === undefined) {
      const { slug, version, manifestJson } = decision.plugin;
      const result = reader.read({ slug, version, manifestJson });
      bound = result.valid
        ? { manifest: result.manifest, requested: requestedByManifest(result.manifest.requested) }
        : null;
      boundByPlugin.set(decision.pluginId, bound);
    }

    return bound;
  };

  const pluginServed = stored.filter(
    (decision) =>
      isPluginServing(decision.plugin) &&
      (boundOf(decision)?.requested({ scopeType: decision.scopeType, permissionSlug }) ?? false),
  );

  // Every plugin left holds a manifest that re-validated, read above.
  const servedUnits = await loadServedUnits(db, pluginServed, (pluginId) => boundByPlugin.get(pluginId)?.manifest);

  return pluginServed
    .filter(
      ({ scopeType, scopeId, pluginId }) =>
        scopeType === PluginGrantScope.Server || servedUnits.has(unitKey(scopeType, scopeId, pluginId)),
    )
    .map(({ scopeType, decidedRiskLevel, status }) => ({ scopeType, decidedRiskLevel, status }));
}

/** A plugin's re-validated active manifest, with its manifest bound built once. */
interface BoundManifest {
  readonly manifest: PluginActiveManifest;
  readonly requested: ReturnType<typeof requestedByManifest>;
}

/**
 * The household and user units among `decisions` that serve the decision's
 * plugin. `manifestOf` answers the active manifest of every plugin among
 * `decisions`; the dormancy rule judges each household unit enablement by it.
 */
async function loadServedUnits(
  db: Pick<Prisma.TransactionClient, 'householdPlugin' | 'userPlugin'>,
  decisions: readonly Pick<PluginGrant, 'pluginId' | 'scopeType' | 'scopeId'>[],
  manifestOf: (pluginId: string) => PluginActiveManifest | undefined,
): Promise<ReadonlySet<string>> {
  const at = (scopeType: PluginGrantScope) => decisions.filter((decision) => decision.scopeType === scopeType);
  const households = at(PluginGrantScope.Household);
  const users = at(PluginGrantScope.User);
  const served = new Set<string>();

  if (households.length > 0) {
    // The query is a cross product of households and plugins, so it can
    // return unit enablements no decision names. Only the named, switched-on
    // ones are judged, as the ability read judges no switched-off unit.
    const named = new Set(
      households.map(({ scopeId, pluginId }) => unitKey(PluginGrantScope.Household, scopeId, pluginId)),
    );
    const rows = await db.householdPlugin.findMany({
      where: {
        householdId: { in: [...new Set(households.map(({ scopeId }) => scopeId))] },
        pluginId: { in: [...new Set(households.map(({ pluginId }) => pluginId))] },
      },
      select: { householdId: true, pluginId: true, enabled: true, config: true },
    });
    for (const row of rows) {
      const key = unitKey(PluginGrantScope.Household, row.householdId, row.pluginId);
      if (!named.has(key) || !row.enabled) {
        continue;
      }

      // Each row is a stored unit enablement, so its `config` is the document
      // the rule judges as stored, a JSON `null` included (#1151).
      const dormancy = derivePluginUnitDormancy({
        scopeType: 'Household',
        manifest: manifestOf(row.pluginId) ?? null,
        retainedConfig: row.config,
      });
      if (isPluginUnitServed(row, dormancy)) {
        served.add(key);
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
      // A user unit is not judged on configuration (#228), as the ability read
      // does not judge it: it is served when it is switched on.
      if (isPluginUnitServed(row, null)) {
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
