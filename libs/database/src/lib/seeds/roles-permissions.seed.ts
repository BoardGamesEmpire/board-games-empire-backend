import type { Logger } from '@nestjs/common';
import { CATALOG_MANIFEST, reconcileCatalog, type ReconcilePlan, type ReconcileResult } from '../catalog';
import type { PrismaClient } from '../client';

/**
 * Reconciles the permission and role catalogs into the database: the last
 * phase of `runSeeds`, after the reference seeds.
 *
 * The catalog itself — `PERMISSION_CATALOG`, `ROLE_CATALOG`,
 * `ROLE_PERMISSION_CATALOG`, bundled as `CATALOG_MANIFEST` — is data owned by
 * `@bge/database` (#233), and so is the reconciler that writes it (#235):
 * `System`-owned rows converge to the manifest, `Admin`-owned rows are left
 * alone with their drift logged, a `System` grant the manifest no longer lists
 * is revoked, and a `System` permission it no longer defines is retired.
 *
 * This is the one call into it, reached from `runSeeds` by the CLI and by the
 * boot sequence alike. `invalidate` is the reconciler's port: the boot sequence
 * passes its cache flush, so a reconcile that wrote rows evicts the cached
 * ability graphs before the api serves a request (#236); the CLI has no Redis,
 * passes nothing, and the reconciler warns that caches were not touched. The
 * result comes back so the boot summary can report what was written.
 */
export async function rolesAndPermissionsSeed(
  prisma: PrismaClient,
  logger: Logger,
  invalidate?: (plan: ReconcilePlan) => Promise<void>,
): Promise<ReconcileResult> {
  logger.log('📋 Reconciling the permission catalog...');

  const result = await reconcileCatalog(prisma, CATALOG_MANIFEST, { logger, invalidate });

  logger.log('✅ Permission catalog reconciled.');
  return result;
}
