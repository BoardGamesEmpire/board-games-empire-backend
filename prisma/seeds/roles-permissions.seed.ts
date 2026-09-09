import type { PrismaClient } from '@bge/database';
import { CATALOG_MANIFEST, reconcileCatalog } from '@bge/database';
import type { Logger } from '@nestjs/common';

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
 * This file is the CLI's call into that. It runs under `tsx` with no Redis, so
 * it passes no invalidation port and the reconciler logs that cached ability
 * graphs were not touched; the in-process boot caller (#236) is the one that
 * passes `PermissionsService.invalidateUsers`.
 */
export async function rolesAndPermissionsSeed(prisma: PrismaClient, logger: Logger) {
  logger.log('📋 Reconciling the permission catalog...');

  await reconcileCatalog(prisma, CATALOG_MANIFEST, { logger });

  logger.log('✅ Permission catalog reconciled.');
}
