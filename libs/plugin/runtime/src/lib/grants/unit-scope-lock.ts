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
 * EVERY writer of `HouseholdPlugin`/`UserPlugin` enablement state takes
 * the matching lock, unconditionally — even call sites operating on
 * existing rows, where a row `FOR UPDATE` would technically suffice
 * (locked on #59 for #323). Do NOT remove the lock from such a site as an
 * optimization: uniformity is what keeps the total lock order
 * (grant row → advisory → unit row) a rule instead of a per-site
 * argument, and a writer that skips the advisory reopens the pre-row
 * race class for every creator it can overlap with. The one deliberate
 * exception is activation's batched suspension pass, which predates the
 * scheme and stays eventually consistent by design (#361 owns the
 * residual).
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
