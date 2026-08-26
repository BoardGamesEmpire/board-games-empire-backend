import {
  PluginCategory,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
  type PrismaClient,
} from '@bge/database';
import { randomUUID } from 'node:crypto';

/**
 * Rows and probe statements for the plugin lock specs — the mechanics tier
 * (#383) and the interaction tier (#360) — which need something real to contend
 * over and nothing else.
 *
 * Deliberately not the C4 suites' `arrangePlugin`: those build a valid manifest
 * because they go on to make HTTP requests that validate it. These specs make no
 * requests at all — they speak to Postgres directly — so a row satisfying the
 * schema is the whole requirement, and a manifest shaped like a real one would
 * only invite the reader to believe it mattered here.
 *
 * The household equivalents live in `../household/lock-fixtures`. They are not
 * shared: each file arranges the rows its own locks contend over, and the two
 * have no fixture in common beyond a `User` row. #384 decides what, if anything,
 * gets promoted once both suites exist.
 */

/**
 * What `uninstallPlugin` does to the plugin row, as a statement a barrier can
 * hold open (`plugin-lifecycle.service.ts` — the `plugin.updateMany` claim).
 *
 * Prisma issues the UPDATE; what matters for every lock question here is that
 * it writes only non-key columns, which makes it a `FOR NO KEY UPDATE` — the
 * mode `FOR SHARE` conflicts with and `FOR KEY SHARE` does not. The
 * `uninstalled_at IS NULL` predicate is the claim itself: exactly one
 * transaction can take it, and a second finds nothing to update.
 */
export const UNINSTALL_CLAIM =
  'UPDATE plugins SET uninstalled_at = now(), enabled = false, restart_required = true, updated_at = now() ' +
  'WHERE id = $1 AND uninstalled_at IS NULL RETURNING id';

/**
 * What activation does to the plugin row when it promotes a staged version.
 *
 * Stands in for `plugin-update.service.ts`'s approval write for one purpose
 * only: it is the concurrent change whose visibility the unit path's re-read
 * claims to guarantee. Again non-key columns, so again `FOR NO KEY UPDATE`.
 */
export const ACTIVATION_VERSION_BUMP =
  'UPDATE plugins SET version = $2, updated_at = now() WHERE id = $1 RETURNING version';

/**
 * The lock a `household_plugins` / `user_plugins` insert takes on its parent
 * plugin row implicitly, through the foreign key.
 *
 * Stated explicitly so a spec can ask what that mode does on its own — it is
 * the mode that does NOT stop an uninstall, which is the entire reason the unit
 * paths take an explicit `FOR SHARE` as well.
 */
export const FK_PLUGIN_LOCK = 'SELECT p.id FROM plugins p WHERE p.id = $1 FOR KEY SHARE';

/**
 * What `decide()` does to an existing grant row, as a statement a barrier can
 * hold open.
 *
 * Prisma issues the real one as an upsert — `INSERT … ON CONFLICT DO UPDATE` —
 * and its update arm is this write. Standing in for it follows the
 * `UNINSTALL_CLAIM` precedent, and what matters for every ordering question is
 * unchanged: it writes non-key columns, so it takes `FOR NO KEY UPDATE`, which
 * is the mode activation's `FOR UPDATE` on the same row conflicts with in both
 * directions. The insert arm is deliberately NOT modelled: a row that does not
 * exist cannot be locked, which is the gap #356's comment leaves to the unique
 * index and the retry.
 */
export const GRANT_DECISION_CLAIM =
  'UPDATE plugin_grants SET status = $2, decided_at = now(), updated_at = now() WHERE id = $1 RETURNING id';

/**
 * The shape of activation's unit-set read — a plain, unlocked scan
 * (`plugin-update.service.ts`, the batched suspension pass).
 *
 * Retyped rather than lifted, because the real one is Prisma's `findMany` and
 * there is no template to lift. That makes it the weakest stand-in in this
 * file, and the weakness is specific: it copies the PREDICATE as well as the
 * mode, so a future narrowing of that `findMany` — scoping it by household, or
 * adding `enabled` — would leave the characterization green over a read the
 * application no longer performs. #361 is the issue most likely to do that, and
 * the spec using this says so.
 *
 * What it is here to model is the mode: no lock, no advisory key, so it cannot
 * see an uncommitted creation and nothing makes it wait for one.
 */
export const ACTIVATION_UNIT_SCAN =
  'SELECT id, household_id FROM household_plugins WHERE plugin_id = $1 AND suspended_for_consent = false';

/**
 * A household unit row created the way the enable path creates it, as a
 * statement a barrier can hold open mid-transaction.
 *
 * Named rather than retyped at each call site: two specs need an uncommitted
 * creation, and a second hand-typed copy is the drift `shipped-sql.ts` exists
 * to prevent, arriving through the back door.
 */
export const UNIT_ANCHOR_INSERT =
  'INSERT INTO household_plugins (id, household_id, plugin_id, updated_at) VALUES ($1, $2, $3, now()) RETURNING id';

/**
 * What a mirror suspend pass writes once it holds the unit row, as a statement
 * a barrier can hold open (`plugin-grant.service.ts` — the pass's Prisma
 * update).
 *
 * Stands in for the write only. What the specs care about is that a contender
 * blocked on the row lock re-reads THIS value rather than its own snapshot,
 * which is what makes the pass's `unit.suspendedForConsent` short-circuit
 * idempotent under contention rather than merely usually right.
 */
export const UNIT_SUSPEND_CLAIM =
  'UPDATE household_plugins SET suspended_for_consent = true, suspended_at = now(), updated_at = now() ' +
  'WHERE id = $1 RETURNING id';

export interface PluginLockFixture {
  readonly pluginId: string;
  readonly slug: string;
  readonly version: string;
}

/**
 * An installed, living plugin row.
 *
 * `manifestJson` is a placeholder: no code under test in these specs reads it,
 * and nothing here validates it.
 */
export async function arrangePlugin(prisma: PrismaClient): Promise<PluginLockFixture> {
  const slug = `lock-fixture-${randomUUID()}`;
  const version = '1.0.0';

  const plugin = await prisma.plugin.create({
    data: {
      slug,
      version,
      category: PluginCategory.FeedbackSink,
      scope: PluginScope.Household,
      manifestJson: { slug, version },
      enabled: true,
      bundled: false,
    },
    select: { id: true },
  });

  return { pluginId: plugin.id, slug, version };
}

/**
 * A household and the user who created it, for the cases that need a real unit
 * row rather than a statement standing in for one.
 *
 * Users are written directly rather than signed up: these specs never
 * authenticate, so a `User` row satisfying the foreign keys is the whole
 * requirement.
 */
export async function arrangeHouseholdFor(prisma: PrismaClient): Promise<{ householdId: string; userId: string }> {
  const handle = randomUUID();
  const user = await prisma.user.create({
    data: { username: `plugin-lock-${handle}`, email: `plugin-lock-${handle}@example.test` },
    select: { id: true },
  });
  const household = await prisma.household.create({
    data: { name: `plugin-lock-fixture-${handle}`, createdById: user.id },
    select: { id: true },
  });

  return { householdId: household.id, userId: user.id };
}

/**
 * A grant row for a plugin, at whichever consent scope the caller needs.
 *
 * The slug defaults to a fresh one per call rather than to a fixed name. The
 * uniqueness index is `(plugin, scope type, scope id, slug)`, and server-scope
 * rows share the empty-string scope sentinel — so a shared default turns
 * "arrange two grants for this plugin" into a raw unique violation raised from
 * inside a fixture, which reads as an unrelated flake. Callers that care which
 * slug it is say so.
 */
export async function arrangeGrant(
  prisma: PrismaClient,
  options: {
    readonly pluginId: string;
    readonly scopeType?: PluginGrantScope;
    readonly scopeId?: string;
    readonly permissionSlug?: string;
    readonly status?: PluginGrantStatus;
  },
): Promise<{ grantId: string; permissionSlug: string }> {
  const permissionSlug = options.permissionSlug ?? `lock-fixture:${randomUUID()}`;
  const grant = await prisma.pluginGrant.create({
    data: {
      pluginId: options.pluginId,
      scopeType: options.scopeType ?? PluginGrantScope.Server,
      scopeId: options.scopeId ?? '',
      permissionSlug,
      status: options.status ?? PluginGrantStatus.Granted,
      manifestVersion: '1.0.0',
      decidedRiskLevel: RiskLevel.Low,
      decidedAt: new Date(),
    },
    select: { id: true },
  });

  return { grantId: grant.id, permissionSlug };
}

/**
 * A server-scope grant row, so activation's `FOR UPDATE` has something to lock.
 *
 * The lock covers EXISTING rows only, which is a claim the specs test in both
 * directions — so a fixture that quietly created the row for a case about its
 * absence would be the whole answer. Callers say which they want.
 */
export async function arrangeServerGrant(
  prisma: PrismaClient,
  pluginId: string,
  permissionSlug?: string,
  status: PluginGrantStatus = PluginGrantStatus.Granted,
): Promise<{ grantId: string; permissionSlug: string }> {
  return arrangeGrant(prisma, { pluginId, permissionSlug, status });
}

/**
 * An existing household unit row — the case where a row lock has a row.
 *
 * Its absence is the pre-row race (#360 step 5), which is why every spec that
 * uses this states whether it wanted the row to exist.
 */
export async function arrangeHouseholdUnit(
  prisma: PrismaClient,
  householdId: string,
  pluginId: string,
): Promise<{ unitId: string }> {
  const unit = await prisma.householdPlugin.create({
    data: { householdId, pluginId },
    select: { id: true },
  });

  return { unitId: unit.id };
}

/**
 * An existing user unit row, the twin of {@link arrangeHouseholdUnit}.
 *
 * Created directly rather than through `decide()`: these specs never
 * authenticate, and #225 makes the decision path the only creator over the
 * wire — which is a fact the interaction tier tests rather than relies on.
 */
export async function arrangeUserUnit(
  prisma: PrismaClient,
  userId: string,
  pluginId: string,
): Promise<{ unitId: string }> {
  const unit = await prisma.userPlugin.create({
    data: { userId, pluginId },
    select: { id: true },
  });

  return { unitId: unit.id };
}
