import { PluginCategory, PluginScope, type PrismaClient } from '@bge/database';
import { randomUUID } from 'node:crypto';

/**
 * Rows and probe statements for the plugin LOCK MECHANICS specs (#383), which
 * need something real to contend over and nothing else.
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
