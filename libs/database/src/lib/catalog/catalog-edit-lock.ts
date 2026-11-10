import type { Prisma } from '../client';

/**
 * The advisory lock every writer of the permission catalog holds for its
 * transaction (#772): each of the Owner's edits, and a start's reconcile.
 * Postgres derives the 64-bit key from the name (`hashtextextended(name, 0)`),
 * as it does for the bootstrap lock (`bge:bootstrap`) and the Owner election
 * (`bge:owner-election`), so no caller computes the key and none can pick one
 * that collides by hand. The `bge:` names, the plugin unit-scope keys
 * (`plugin_grant:…`) and the quota keys all share the 64-bit keyspace; a
 * collision would only make two unrelated writers wait for each other, never
 * let either skip a lock.
 */
export const CATALOG_EDIT_LOCK_NAME = 'bge:permission-catalog-edit';

/**
 * Serializes the writers of the permission catalog (#772). Call it as the
 * first statement of the transaction: every edit of the Owner's (a permission
 * edited, a grant given or revoked, a role's description, a hand back), and
 * `reconcileCatalog`.
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
 * A start's reconcile is such a writer too. Without the lock, an edit that
 * commits after the start reads the tables is never judged by that start,
 * and the edit's own check never sees the grants the start then creates: a
 * newer version gives a household role a permission the Owner just made
 * unconditioned, and it reaches every household until the next start. Under
 * it, an edit either commits before the start reads, and the start's entry
 * check judges it, or waits for the start to commit, and its own check sees
 * what the start wrote.
 *
 * Lock order, so no two writers can wait on each other in a cycle: a start
 * holds `bge:bootstrap`, on a connection of its own, before its reconcile
 * takes this lock; an edit takes only this one, and never waits for
 * `bge:bootstrap`. `bge:owner-election` is taken only by provisioning a user,
 * which takes neither of the others. And every holder takes this lock before
 * any row lock, so a transaction waiting for it holds nothing another holder
 * could be waiting for.
 *
 * Released when the transaction commits or rolls back.
 */
export async function lockCatalogEdits(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${CATALOG_EDIT_LOCK_NAME}, 0))`;
}
