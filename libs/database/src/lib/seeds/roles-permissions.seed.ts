import type { Logger } from '@nestjs/common';
import { CATALOG_MANIFEST, reconcileCatalog } from '../catalog';
import type { PrismaClient } from '../client';

/**
 * Reconciles the permission and role catalogs into the database.
 *
 * The catalog itself — `PERMISSION_CATALOG`, `ROLE_CATALOG`,
 * `ROLE_PERMISSION_CATALOG`, bundled as `CATALOG_MANIFEST` — is data owned by
 * `@bge/database` (#233), and so is the reconciler that writes it (#235):
 * `System`-owned rows converge to the manifest, `Admin`-owned rows are left
 * alone with their drift logged, a `System` grant the manifest no longer lists
 * is revoked, and a `System` permission it no longer defines is retired.
 *
 * This is the one call into it, reached from `runSeeds` by the CLI and by the
 * boot sequence alike. Neither passes an invalidation port yet, so the
 * reconciler warns that cached ability graphs were not touched; the boot
 * caller's cache flush is the next pull request of #236, which threads it
 * through `runSeeds`.
 */
export async function rolesAndPermissionsSeed(prisma: PrismaClient, logger: Logger) {
  logger.log('📋 Reconciling the permission catalog...');

  await reconcileCatalog(prisma, CATALOG_MANIFEST, { logger });

  logger.log('✅ Permission catalog reconciled.');
}
