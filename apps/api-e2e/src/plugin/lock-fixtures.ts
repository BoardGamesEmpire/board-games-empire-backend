import { PluginGrantScope, PluginGrantStatus, PluginScope, RiskLevel, type PrismaClient } from '@bge/database';
import { randomUUID } from 'node:crypto';
import { FIXTURE_ACT_ID, pluginRowData } from './plugin-row-fixtures';

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
 * The insert arm of a consent decision's upsert: a decision on a permission
 * slug that has no grant row yet.
 *
 * Its only lock on the plugin row is the `FOR KEY SHARE` its foreign key
 * takes. A row lock on a plugin's consent decisions covers the rows that
 * exist, and a `FOR UPDATE` matching zero rows locks nothing, so this insert
 * walks straight past a holder with every EXISTING consent decision for the
 * plugin locked.
 * That is not a defect: it is why every writer of a consent decision claims
 * the plugin row before it writes (#398, #1336), and why every decision is
 * written by upsert, whose insert waits for one in flight on the same row and
 * then updates it rather than colliding (#1152).
 *
 * Named rather than typed at its one call site, and the enum values are the
 * enum members rather than quoted literals. The column list and the vocabulary
 * then live where the file's other statements do, and a renamed value is a
 * compile error instead of a barrier case failing in a way that reads as a
 * lock defect.
 */
export const SERVER_GRANT_INSERT =
  `INSERT INTO plugin_grants
     (id, plugin_id, scope_type, scope_id, permission_slug, status, act_id, decided_risk_level,
      decided_at, updated_at)
   VALUES ($1, $2, '${PluginGrantScope.Server}', '', $3, '${PluginGrantStatus.Granted}', '${FIXTURE_ACT_ID}', ` +
  `'${RiskLevel.Low}', now(), now())
   RETURNING id`;

export interface PluginLockFixture {
  readonly pluginId: string;
  readonly slug: string;
  readonly version: string;
}

/**
 * An installed, living plugin row.
 *
 * `manifestJson` is a minimal document, not a real manifest: nothing here
 * validates it. It is no longer inert, though — the share lock's statement
 * compares it (#368) — so a case may read this row's document back and bind
 * it. What such a case must NOT do is rebuild it from `slug`/`version` and
 * call that the stored document; the comparison is only worth running against
 * what Postgres actually holds.
 */
export async function arrangePlugin(prisma: PrismaClient): Promise<PluginLockFixture> {
  const slug = `lock-fixture-${randomUUID()}`;
  const version = '1.0.0';

  const plugin = await prisma.plugin.create({
    data: pluginRowData({
      slug,
      version,
      scope: PluginScope.Household,
      manifestJson: { slug, version },
      enabled: true,
    }),
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
    data: { name: `plugin-lock-fixture-${handle}`, createdById: user.id, settings: { create: {} } },
    select: { id: true },
  });

  return { householdId: household.id, userId: user.id };
}
