/**
 * One row of Prisma's `_prisma_migrations` ledger, the four columns boot
 * needs. `started_at` is always set; a row with neither `finished_at` nor
 * `rolled_back_at` is a migration that began and never completed.
 */
export interface AppliedMigrationRow {
  readonly finished_at: Date | null;
  readonly migration_name: string;
  readonly rolled_back_at: Date | null;
  readonly started_at: Date;
}

/**
 * `failed` outranks everything: nothing safe can be done over a half-applied
 * migration. `behind` outranks `ahead` because pending migrations are what a
 * migrator acts on, while unknown ones are only reported. `ahead` is a warning,
 * not a refusal: a rollback over an additive migration must still boot
 * (#236).
 *
 * `diverged` is a database holding migrations this build does not know, every
 * one of which a migration run before the last run of migrations this build
 * knows applied: the migration history was rewritten, by a migration renamed
 * or deleted on master or by switching branches over one database (#1148).
 * A rollback looks different: the newer build's migrations came in the last
 * run. Not by name, because migrations reach master out of name order. Not by
 * `finished_at` alone either: one `migrate deploy` applies its pending
 * migrations in name order, so a newer build's migration merged out of order
 * finishes just before the later-named ones in the same run, and a rollback
 * to the build that lacks only it would read diverged and reconcile the newer
 * build's catalog away. `ahead` outranks `diverged`: one migration newer than
 * this build is enough to say a newer build owns the data.
 */
export type MigrationStateKind = 'in-sync' | 'behind' | 'ahead' | 'diverged' | 'failed';

export interface MigrationState {
  /**
   * The unknown migrations applied by a run before the last run that applied
   * migrations this build knows: the history was rewritten (#1148). A subset
   * of `unknown`.
   */
  readonly diverged: readonly string[];

  /** Started, and neither finished nor rolled back. */
  readonly failed: readonly string[];

  readonly kind: MigrationStateKind;

  /** Expected by this build, not finished in the database; apply order. */
  readonly pending: readonly string[];

  /** Finished in the database, unknown to this build. */
  readonly unknown: readonly string[];
}

/**
 * The longest a `migrate deploy` waits between one migration finishing and
 * the next starting, with a wide margin: measured at under 2ms over the whole
 * chain (#1148). A longer gap is another run, a later boot or a later
 * `migrate dev`, and no rename reaches a database faster than a new build.
 */
const MIGRATION_RUN_GAP_MS = 10_000;

type FinishedMigrationRow = AppliedMigrationRow & { readonly finished_at: Date };

/**
 * Compares the migrations this build was generated from with the rows in
 * `_prisma_migrations`. Pure, so every row of the decision is a unit test;
 * the read is `readAppliedMigrations`.
 *
 * A rolled-back row counts as not applied: `prisma migrate resolve
 * --rolled-back` is how an operator clears a failed migration for
 * `migrate deploy` to retry, and the row stays behind, marked. Only rows
 * finished and not rolled back count toward `diverged`.
 */
export function classifyMigrationState(
  expected: readonly string[],
  applied: readonly AppliedMigrationRow[],
): MigrationState {
  const known = new Set(expected);
  const finishedRows = applied.filter(
    (row): row is FinishedMigrationRow => row.finished_at !== null && row.rolled_back_at === null,
  );
  const finishedNames = new Set(finishedRows.map((row) => row.migration_name));

  const pending = expected.filter((name) => !finishedNames.has(name));
  const unknown = [...finishedNames].filter((name) => !known.has(name)).sort();
  const failed = applied
    .filter((row) => row.finished_at === null && row.rolled_back_at === null)
    .map((row) => row.migration_name)
    .sort();

  const diverged = divergedMigrations(finishedRows, known);

  return { kind: kindOf(pending, unknown, diverged, failed), pending, unknown, diverged, failed };
}

/**
 * Groups the finished rows into runs, by the gap between one migration
 * finishing and the next starting, and returns the unknown migrations whose
 * latest row came in a run before the last run holding a migration this
 * build knows.
 */
function divergedMigrations(finishedRows: readonly FinishedMigrationRow[], known: ReadonlySet<string>): string[] {
  const byStart = [...finishedRows].sort(
    (a, b) => a.started_at.getTime() - b.started_at.getTime() || a.finished_at.getTime() - b.finished_at.getTime(),
  );
  let run = 0;
  let runEnd = Number.NEGATIVE_INFINITY;
  let lastKnownRun = 0;
  const unknownRun = new Map<string, number>();

  for (const row of byStart) {
    if (row.started_at.getTime() - runEnd > MIGRATION_RUN_GAP_MS) {
      run += 1;
    }

    runEnd = Math.max(runEnd, row.finished_at.getTime());

    // Rows come in start order, so the last assignment is the latest run.
    if (known.has(row.migration_name)) {
      lastKnownRun = run;
    } else {
      unknownRun.set(row.migration_name, run);
    }
  }

  return [...unknownRun]
    .filter(([, unknownRunIndex]) => unknownRunIndex < lastKnownRun)
    .map(([name]) => name)
    .sort();
}

function kindOf(
  pending: readonly string[],
  unknown: readonly string[],
  diverged: readonly string[],
  failed: readonly string[],
): MigrationStateKind {
  if (failed.length > 0) {
    return 'failed';
  }

  if (pending.length > 0) {
    return 'behind';
  }

  if (unknown.length > diverged.length) {
    return 'ahead';
  }

  if (diverged.length > 0) {
    return 'diverged';
  }

  return 'in-sync';
}
