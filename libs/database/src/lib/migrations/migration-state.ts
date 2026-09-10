/**
 * One row of Prisma's `_prisma_migrations` ledger, the three columns boot
 * needs. `started_at` is always set; a row with neither `finished_at` nor
 * `rolled_back_at` is a migration that began and never completed.
 */
export interface AppliedMigrationRow {
  readonly migration_name: string;
  readonly finished_at: Date | null;
  readonly rolled_back_at: Date | null;
}

/**
 * `failed` outranks everything: nothing safe can be done over a half-applied
 * migration. `behind` outranks `ahead` because pending migrations are what a
 * migrator acts on, while unknown ones are only reported. `ahead` is a warning,
 * not a refusal: a rollback over an additive migration must still boot
 * (#236).
 */
export type MigrationStateKind = 'in-sync' | 'behind' | 'ahead' | 'failed';

export interface MigrationState {
  readonly kind: MigrationStateKind;
  /** Expected by this build, not finished in the database; apply order. */
  readonly pending: readonly string[];
  /** Finished in the database, unknown to this build. */
  readonly unknown: readonly string[];
  /** Started, and neither finished nor rolled back. */
  readonly failed: readonly string[];
}

/**
 * Compares the migrations this build was generated from with the rows in
 * `_prisma_migrations`. Pure, so every row of the decision is a unit test;
 * the read is `readAppliedMigrations`.
 *
 * A rolled-back row counts as not applied: `prisma migrate resolve
 * --rolled-back` is how an operator clears a failed migration for
 * `migrate deploy` to retry, and the row stays behind, marked.
 */
export function classifyMigrationState(
  expected: readonly string[],
  applied: readonly AppliedMigrationRow[],
): MigrationState {
  const known = new Set(expected);
  const finishedNames = new Set(
    applied.filter((row) => row.finished_at !== null && row.rolled_back_at === null).map((row) => row.migration_name),
  );

  const pending = expected.filter((name) => !finishedNames.has(name));
  const unknown = [...finishedNames].filter((name) => !known.has(name)).sort();
  const failed = applied
    .filter((row) => row.finished_at === null && row.rolled_back_at === null)
    .map((row) => row.migration_name)
    .sort();

  return { kind: kindOf(pending, unknown, failed), pending, unknown, failed };
}

function kindOf(pending: readonly string[], unknown: readonly string[], failed: readonly string[]): MigrationStateKind {
  if (failed.length > 0) return 'failed';
  if (pending.length > 0) return 'behind';
  if (unknown.length > 0) return 'ahead';
  return 'in-sync';
}
