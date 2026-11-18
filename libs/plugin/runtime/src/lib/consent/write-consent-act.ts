import type { PluginConsentAct, PluginConsentActKind, PluginGrant, PluginGrantScope, Prisma } from '@bge/database';
import type { WrittenDecision } from './consent-decision-events';
import { decisionStands } from './consent-decision-stands';
import type { ConsentActDecision, ConsentActPresentation } from './plugin-consent-act.types';

export interface ConsentActWrite {
  readonly actorId: string;
  readonly correlationId: string | null;
  readonly decidedAt: Date;
  /** In permission order: the order every writer takes the rows in. */
  readonly decisions: readonly ConsentActDecision[];
  readonly kind: PluginConsentActKind;
  readonly manifestSha256: string;
  readonly manifestVersion: string;
  readonly pluginId: string;
  readonly pluginSlug: string;
  readonly presentation: ConsentActPresentation;
  /** Household.id or User.id; SERVER_SCOPE_SENTINEL for the Server unit. */
  readonly scopeId: string;
  readonly scopeType: PluginGrantScope;
  /**
   * The staged update the act answered: the plugin row's `pendingStagingId`
   * when `manifestSha256` names the staged manifest, null for an act on the
   * active one. Rejecting that staging deletes the decisions whose act names
   * it (#1152).
   */
  readonly stagingId: string | null;
  /** The rows read before the write, by permission slug; a missing slug had no decision. */
  readonly standingBySlug: ReadonlyMap<string, PluginGrant>;
}

export interface WrittenConsentAct {
  readonly act: PluginConsentAct;
  /** The decisions whose row changed (`decisionStands` false), a fresh row included: `before` is null there. */
  readonly changed: readonly WrittenDecision[];
  /** Every decision's row after the write, in `decisions` order. */
  readonly rows: readonly PluginGrant[];
}

/**
 * Records one consent act and the consent decisions it carries (#1152): the
 * household and user act, the server act, install and update approval all
 * write through here. It takes no lock and emits no event: each caller claims
 * the plugin row before calling it and announces what changed after its
 * transaction commits.
 *
 * Every decision it is handed is written, one that already stands included,
 * so a row's `actId` names the act that last wrote it. A staged review hands
 * it only the decisions it changes, so a decision kept from an earlier
 * manifest keeps naming the act that gave it (#1152). Each is one upsert on
 * the unit's coordinates, so an act that read no row for a permission updates
 * the row another act inserted since, and the later write wins.
 *
 * The decisions are written in the order given, which every caller sorts by
 * permission slug in code-unit order (`byPermissionSlugCodeUnit`): two acts
 * on one unit then take their consent decision rows in the same order, where
 * any other order lets each hold a row the other waits on.
 */
export async function writeConsentAct(
  tx: Prisma.TransactionClient,
  input: ConsentActWrite,
): Promise<WrittenConsentAct> {
  const { pluginId, scopeType, scopeId } = input;

  const act = await tx.pluginConsentAct.create({
    data: {
      pluginId,
      pluginSlug: input.pluginSlug,
      scopeType,
      scopeId,
      kind: input.kind,
      manifestVersion: input.manifestVersion,
      manifestSha256: input.manifestSha256,
      stagingId: input.stagingId,
      presentation: input.presentation as unknown as Prisma.InputJsonValue,
      decidedById: input.actorId,
      decidedAt: input.decidedAt,
      correlationId: input.correlationId,
    },
  });

  const rows: PluginGrant[] = [];
  const changed: WrittenDecision[] = [];

  for (const decision of input.decisions) {
    const coordinates = { pluginId, scopeType, scopeId, permissionSlug: decision.permissionSlug };
    const fields = {
      status: decision.status,
      decidedRiskLevel: decision.decidedRiskLevel,
      decidedById: input.actorId,
      decidedAt: input.decidedAt,
      actId: act.id,
    };
    const after = await tx.pluginGrant.upsert({
      where: { pluginId_scopeType_scopeId_permissionSlug: coordinates },
      create: { ...coordinates, ...fields },
      update: fields,
    });
    const before = input.standingBySlug.get(decision.permissionSlug) ?? null;

    rows.push(after);

    if (!decisionStands(decision, before)) {
      changed.push({ before, after });
    }
  }

  return { act, rows, changed };
}
