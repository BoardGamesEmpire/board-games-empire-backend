import type { Prisma } from '@bge/database';

/**
 * The advisory lock every edit of the permission catalog holds for its
 * transaction (#772). Postgres derives the 64-bit key from the name
 * (`hashtextextended(name, 0)`), as it does for the bootstrap lock
 * (`bge:bootstrap`) and the Owner election (`bge:owner-election`), so no
 * caller computes the key and none can pick one that collides by hand. The
 * `bge:` names, the plugin unit-scope keys (`plugin_grant:…`) and the quota
 * keys all share the 64-bit keyspace; a collision would only make two
 * unrelated writers wait for each other, never let either skip a lock.
 */
export const CATALOG_EDIT_LOCK_NAME = 'bge:permission-catalog-edit';

/**
 * Serializes the Owner's edits of the permission catalog (#772). Call it as
 * the first statement of every edit's transaction: a permission edit, a grant
 * given or revoked, a role's description, a hand back.
 *
 * A row lock on the edited entry is not enough. The entry check judges the
 * whole permission catalog, not one row: the pairing of grants, the base
 * role's exemption from the unconditioned-grant guards, and the reach guard
 * each read every holder of a slug, or every slug a role holds. Two edits on
 * different rows can each pass against the permission catalog without the
 * other, and together make a grant that fails open. Under this lock each
 * edit's check reads the permission catalog with every earlier edit
 * committed: the transaction runs at READ COMMITTED, so each statement after
 * the wait takes a fresh snapshot.
 *
 * Released when the transaction commits or rolls back.
 */
export async function lockCatalogEdits(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CATALOG_EDIT_LOCK_NAME}, 0))`;
}
