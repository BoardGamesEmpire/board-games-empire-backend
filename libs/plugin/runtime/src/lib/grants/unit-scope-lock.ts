import type { Prisma } from '@bge/database';

/**
 * Advisory locks serializing every writer of one unit's enablement state
 * for one plugin — including writers that run BEFORE the unit row exists.
 *
 * A `FOR UPDATE` on the unit row cannot order a row-creating transaction
 * against a concurrent writer: while the creator's INSERT is uncommitted,
 * the other side's lock query finds no row to wait on, and while that
 * side's write is uncommitted, the creator's probes cannot see it under
 * READ COMMITTED — both commit believing the other absent (PR #359
 * round 6). The advisory key exists before the row does, so whichever
 * transaction takes it second observes the first's commit.
 *
 * EVERY writer of one unit's enablement — its switch, its settings, the row
 * itself — takes the matching lock, unconditionally: switching a plugin on
 * or off, a settings write, and the consent act whose switch-on creates the
 * row (#1150). That holds even at call sites operating on existing rows,
 * where a row `FOR UPDATE` would technically suffice (locked on #59 for
 * #323). Do NOT remove the lock from such a site as an optimization:
 * uniformity is what keeps the total lock order
 * (plugin row → advisory → grant row → unit row) a rule instead of a
 * per-site argument, and a writer that skips the advisory reopens the
 * pre-row race class for every creator it can overlap with.
 *
 * Uninstall's purge is the exception, and only because it holds the plugin
 * row exclusively first. Every per-unit writer locks the plugin row
 * `FOR SHARE` before this lock, so its write either committed before the claim
 * or waits behind it. Activation and reinstall write no unit enablement:
 * activation only reads which units owe re-consent (#1149), and whether a
 * unit can run under the manifest either one promotes is worked out when read
 * (#1151).
 *
 * The plugin row sorts BEFORE this lock, and that is a correctness
 * constraint rather than a convention: every per-unit writer holds the plugin
 * row while it acquires this lock, and uninstall and activation take that row
 * exclusively. A caller that took this lock and then read the plugin row could
 * queue behind an uninstall or activation waiting for that row, while the
 * per-unit writer the uninstall or activation waits on, holding the row shared,
 * waits for this lock: a cycle Postgres resolves by aborting somebody (PR #363
 * review). Read the plugin row first.
 *
 * A consent act takes this lock before its consent decisions, so two acts on
 * one unit read and write those decisions one act at a time (#1150). No other
 * writer takes both this lock and a grant row, so the order between the two
 * closes no cycle.
 *
 * Postgres derives the 64-bit key itself (`hashtextextended`) —
 * deliberately NOT a cryptographic hash: nothing here is protected by the
 * digest, a collision only over-serializes two unrelated units, and a
 * crypto API around a scope id reads as data protection where none is
 * intended. Same int8 keyspace discipline as QuotaService.advisoryLockKey.
 */
export async function lockHouseholdUnitScope(
  tx: Prisma.TransactionClient,
  householdId: string,
  pluginId: string,
): Promise<void> {
  const scopeKey = `plugin_grant:household_unit:${householdId}:${pluginId}`;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`;
}

/** The user-scope twin — see {@link lockHouseholdUnitScope} for the contract. */
export async function lockUserUnitScope(tx: Prisma.TransactionClient, userId: string, pluginId: string): Promise<void> {
  const scopeKey = `plugin_grant:user_unit:${userId}:${pluginId}`;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`;
}
