import { PluginScope, PluginUnitDormantReason, type HouseholdPlugin, type Prisma } from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { HouseholdPluginUnitDormantEvent, HouseholdPluginUnitRevivedEvent } from '../events/plugin.events';
import { MANIFEST_SCOPE_TO_PRISMA } from '../install/manifest-enum.maps';

type ActiveManifest = PluginManifestValidationResult['manifest'];

/** One household row moving into or out of dormancy under a manifest replacement. */
export interface HouseholdDormancyTransition {
  readonly before: HouseholdPlugin;
  readonly after: HouseholdPlugin;
  /** The reason written, or — when `kind` is `'revived'` — the one cleared. */
  readonly reason: PluginUnitDormantReason;
  readonly kind: 'dormant' | 'revived';
}

/**
 * Reconcile every household row for one plugin against the scope and config
 * schema a manifest replacement is promoting (#369, #370, D-CK–D-CP).
 *
 * Lives here rather than in either caller because BOTH transactions that
 * replace a manifest have to run it: a version activation, and a reinstall over
 * a tombstone — which re-scopes the row from `sharedColumns` exactly as
 * activation does, while `purgeData: false` retained the household rows it would
 * orphan. Two copies of this rule would be two chances for one of them to stop
 * agreeing with the serving predicate.
 *
 * Keyed on the NEW scope alone, never on a household→server *comparison*. The
 * reconciliation a row needs is a function of the manifest now in force, so a
 * pass that asked "did the scope narrow?" would depend on a pre-read of the old
 * value and would silently do nothing for a row some earlier writer left in the
 * wrong state. As written it is idempotent and self-healing: run it twice and
 * the second run finds nothing to move.
 *
 * Batched, and deliberately without the per-unit advisory locks every
 * request-shaped unit writer takes (D-CO, extending the exception
 * `unit-scope-lock.ts` documents). Per-row locks here would acquire N advisory
 * keys AFTER the plugin row, against the total order
 * plugin row → grant row → advisory → unit row, closing the cycle that file
 * warns about. They are also unnecessary: both callers claim the plugin row
 * exclusively before reaching this, and every household unit writer reads that
 * row `FOR SHARE` before touching a unit row — so a concurrent enable either
 * committed before the claim (and is in the rows read here) or blocks until the
 * caller's transaction commits. `decide()` is the writer that does not take the
 * plugin row (#361), and it cannot create or re-scope a household row: it only
 * suspends and re-enables existing ones.
 */
export async function reconcileHouseholdDormancy(args: {
  readonly tx: Prisma.TransactionClient;
  readonly pluginId: string;
  readonly manifest: ActiveManifest;
  readonly configSchema: PluginConfigSchemaService;
  readonly initiatedAt: Date;
}): Promise<HouseholdDormancyTransition[]> {
  const { tx, pluginId, manifest, configSchema, initiatedAt } = args;

  // One read per replacement regardless of how many households run the plugin,
  // matching activation's suspension passes: a per-unit query loop would put
  // the transaction's duration on the install count.
  const rows = await tx.householdPlugin.findMany({ where: { pluginId } });

  if (rows.length === 0) {
    return [];
  }

  if (MANIFEST_SCOPE_TO_PRISMA[manifest.scope] === PluginScope.Server) {
    // Every row is orphaned by this manifest: the scope declares no
    // household-scope consent, so there is no collection point for any of them.
    // `NeedsConfiguration` rows are PROMOTED rather than left alone — D-CP's
    // precedence, and the reason config cannot cure a missing surface.
    const stale = rows.filter((row) => row.dormantReason !== PluginUnitDormantReason.ScopeOrphaned);

    return applyDormancy(tx, stale, PluginUnitDormantReason.ScopeOrphaned, initiatedAt);
  }

  // The scope admits households again. Only rows dormant FOR SCOPE are this
  // pass's business — a `NeedsConfiguration` row's cure is an admin supplying a
  // document, and re-validating every row at every manifest replacement is
  // #370's pass, not this one.
  const orphaned = rows.filter((row) => row.dormantReason === PluginUnitDormantReason.ScopeOrphaned);

  if (orphaned.length === 0) {
    return [];
  }

  // D-CP's accepted cost: a single-valued reason cannot be nulled blindly on the
  // way out. A row whose scope dormancy is lifting may still hold a document the
  // manifest now in force rejects, and reviving it into service with that
  // document is the exact failure #370 describes.
  const { schema, requiresHouseholdConfig } = manifest.config;

  if (requiresHouseholdConfig) {
    configSchema.warm({ slug: manifest.slug, version: manifest.version, schema });
  }

  const nonConforming = requiresHouseholdConfig
    ? orphaned.filter((row) => !configConforms(configSchema, manifest, row))
    : [];
  const condemned = new Set(nonConforming.map((row) => row.id));
  const conforming = orphaned.filter((row) => !condemned.has(row.id));

  return [
    ...(await applyDormancy(tx, nonConforming, PluginUnitDormantReason.NeedsConfiguration, initiatedAt)),
    ...(await revive(tx, conforming, PluginUnitDormantReason.ScopeOrphaned)),
  ];
}

/** Post-commit emissions for one reconciliation, shared by both callers so the two cannot describe the same transition differently. */
export function emitHouseholdDormancy(
  emitter: EventEmitter2,
  transitions: readonly HouseholdDormancyTransition[],
  manifestVersion: string,
  initiatedAt: Date,
): void {
  for (const transition of transitions) {
    const before = snapshot(transition.before);
    const after = snapshot(transition.after);

    if (transition.kind === 'dormant') {
      emitter.emit(
        HouseholdPluginUnitDormantEvent.eventName,
        new HouseholdPluginUnitDormantEvent(before, after, transition.reason, manifestVersion, initiatedAt),
      );
      continue;
    }

    emitter.emit(
      HouseholdPluginUnitRevivedEvent.eventName,
      new HouseholdPluginUnitRevivedEvent(before, after, transition.reason, manifestVersion, initiatedAt),
    );
  }
}

/** The dormancy events' snapshot: the switch fields plus the reason, so a diff shows what moved and what deliberately did not. */
function snapshot(unit: HouseholdPlugin) {
  const { id, householdId, pluginId, enabled, suspendedForConsent, dormantReason } = unit;

  return { id, householdId, pluginId, enabled, suspendedForConsent, dormantReason };
}

/**
 * Does a retained household document satisfy the manifest being promoted? An
 * unusable schema proves nothing about the document, so it does not condemn the
 * row — the first config write raises that loudly (the same posture
 * `retainedServerConfig` takes, inverted only in what it does with the value).
 */
function configConforms(
  configSchema: PluginConfigSchemaService,
  manifest: ActiveManifest,
  row: HouseholdPlugin,
): boolean {
  const config = row.config;

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return false;
  }

  try {
    return (
      configSchema.validate({
        slug: manifest.slug,
        version: manifest.version,
        schema: manifest.config.schema,
        config: config as Record<string, unknown>,
      }).length === 0
    );
  } catch {
    return true;
  }
}

/** Write one dormancy reason across a set of rows in a single statement, and describe the moves for the post-commit emissions. */
async function applyDormancy(
  tx: Prisma.TransactionClient,
  rows: readonly HouseholdPlugin[],
  reason: PluginUnitDormantReason,
  initiatedAt: Date,
): Promise<HouseholdDormancyTransition[]> {
  if (rows.length === 0) {
    return [];
  }

  await tx.householdPlugin.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { dormantReason: reason, dormantAt: initiatedAt },
  });

  // `enabled` is untouched on purpose: dormancy is not the admin's intent, so
  // their switch survives it and a revival restores exactly what they chose —
  // the same discipline consent suspension follows.
  return rows.map((row) => ({
    before: row,
    after: { ...row, dormantReason: reason, dormantAt: initiatedAt },
    reason,
    kind: 'dormant' as const,
  }));
}

/** Lift dormancy across a set of rows in a single statement. `cleared` is what they were, supplied by the caller that selected them. */
async function revive(
  tx: Prisma.TransactionClient,
  rows: readonly HouseholdPlugin[],
  cleared: PluginUnitDormantReason,
): Promise<HouseholdDormancyTransition[]> {
  if (rows.length === 0) {
    return [];
  }

  await tx.householdPlugin.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { dormantReason: null, dormantAt: null },
  });

  return rows.map((row) => ({
    before: row,
    after: { ...row, dormantReason: null, dormantAt: null },
    reason: cleared,
    kind: 'revived' as const,
  }));
}
