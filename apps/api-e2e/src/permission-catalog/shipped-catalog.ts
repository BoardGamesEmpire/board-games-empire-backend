import {
  CATALOG_MANIFEST,
  PermissionOwner,
  reconcileCatalog,
  type PrismaClient,
  type ReconcileResult,
} from '@bge/database';
import { permissionGraphFlushPatterns } from '@bge/permissions';
import { RedisKeyFlush } from '@bge/redis';
import { connectToHarnessRedis } from '../support/redis-reset';

/**
 * The permission catalog as a start leaves it, for the specs that edit it
 * over the Owner's routes (#772).
 *
 * The harness cannot restart the api mid-run, so a start's reconcile is run
 * in process against the harness database, and the cached permission graphs
 * are flushed from the Valkey the api reads, as the api's bootstrap flushes
 * them after a reconcile that wrote rows. The flush is the one the api runs
 * itself after every edit of the permission catalog, so it removes nothing a
 * spec's own requests would not.
 */

const silent = { log: () => undefined, warn: () => undefined };

/** Removes every cached permission graph, as the api does after an edit of the permission catalog. */
export async function flushPermissionGraphs(): Promise<void> {
  const flush = new RedisKeyFlush(connectToHarnessRedis(), permissionGraphFlushPatterns());

  try {
    await flush.flush();
  } finally {
    await flush.close();
  }
}

/** The reconcile a start runs, with the flush the api's bootstrap runs once it wrote rows. */
export function reconcileAsAtStart(client: PrismaClient): Promise<ReconcileResult> {
  return reconcileCatalog(client, CATALOG_MANIFEST, { logger: silent, invalidate: flushPermissionGraphs });
}

/**
 * Puts the permission catalog back as this version ships it, and throws
 * unless it is.
 *
 * Every spec file shares the permission catalog's three tables: the
 * between-test sweep preserves them. A start leaves an entry the Owner
 * edited as it is, so every entry the Owner manages is first handed back the
 * way the routes do it, with its retirement or revocation cleared too; the
 * reconcile then restores the shipped columns, gives back a revoked grant
 * the permission catalog lists, and deletes a grant it doesn't. A direct
 * write to the tables flushes nothing, so the graphs are flushed whether or
 * not the reconcile wrote.
 *
 * Converged means a second reconcile finds nothing to write and nothing the
 * Owner manages, and no permission is retired and no grant revoked, as the
 * seeded database has it.
 */
export async function restoreShippedCatalog(client: PrismaClient): Promise<void> {
  const ownerManaged = { managedBy: PermissionOwner.Admin };

  await client.permission.updateMany({
    where: ownerManaged,
    data: { managedBy: PermissionOwner.System, retiredAt: null },
  });
  await client.role.updateMany({ where: ownerManaged, data: { managedBy: PermissionOwner.System } });
  await client.rolePermission.updateMany({
    where: ownerManaged,
    data: { managedBy: PermissionOwner.System, revokedAt: null },
  });

  await reconcileAsAtStart(client);
  await flushPermissionGraphs();

  const { plan, mutations } = await reconcileCatalog(client, CATALOG_MANIFEST, { logger: silent });
  const left = {
    mutations,
    skippedPermissions: plan.permissions.skipped.length,
    skippedRoles: plan.roles.skipped.length,
    skippedGrants: plan.rolePermissions.skipped.length,
    ownerManagedPermissions: await client.permission.count({ where: ownerManaged }),
    ownerManagedRoles: await client.role.count({ where: ownerManaged }),
    ownerManagedGrants: await client.rolePermission.count({ where: ownerManaged }),
    retiredPermissions: await client.permission.count({ where: { retiredAt: { not: null } } }),
    revokedGrants: await client.rolePermission.count({ where: { revokedAt: { not: null } } }),
  };

  if (Object.values(left).some((count) => count !== 0)) {
    throw new Error(
      `The permission catalog did not converge on the shipped one after a spec edited it, so later specs would ` +
        `inherit the edit (#772): ${JSON.stringify(left)}`,
    );
  }
}
