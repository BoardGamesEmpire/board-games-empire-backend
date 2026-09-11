import { indent, type PlanReport } from '../catalog/catalog-plan-report';
import type { DataMigrationEntry } from './data-migration-entry';
import { assertDataMigrationRegistry, describeMismatch, type DataMigrationsPlan } from './plan-data-migrations';

/**
 * The ledger half of what `npm run db:plan` prints (#236), beside the
 * catalog's `describePlanReport`. Same conventions: a refusal leads, the
 * closing line says the state in one word, and the exit code is 0 for nothing
 * to do, 1 for work the next boot would do, 2 for a boot that would refuse.
 */
export function describeDataMigrationsReport(plan: DataMigrationsPlan): PlanReport {
  const lines: string[] = [];
  const refusing = plan.edited.length > 0;
  const pendingNames = plan.pending.map((entry) => entry.name);

  if (refusing) {
    lines.push(
      "The next api boot would REFUSE to boot: applied data migration(s) are at a revision above the ledger's in " +
        'this build, edited after they ran.',
      ...plan.edited.map(describeMismatch).map(indent),
    );
    if (pendingNames.length > 0) {
      lines.push('', 'Once those are resolved, it would apply, in this order:', ...pendingNames.map(indent));
    }
  } else if (pendingNames.length > 0) {
    lines.push(
      `The next api boot would apply ${pendingNames.length} data migration(s), in this order:`,
      ...pendingNames.map(indent),
    );
  }

  if (plan.ahead.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      "Applied at a revision above this build's, left alone (a newer build ran them, and that build owns the data):",
      ...plan.ahead.map(describeMismatch).map(indent),
    );
  }

  if (plan.unknown.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      'Ledger rows the registry does not know, left alone (a newer build applied them, or an entry was removed):',
      ...plan.unknown.map(indent),
    );
  }

  if (lines.length > 0) lines.push('');
  lines.push(closingLine(pendingNames.length, plan.applied.length, refusing));

  return { lines, exitCode: refusing ? 2 : pendingNames.length > 0 ? 1 : 0 };
}

/**
 * The same half when the ledger table is not there. The CLI plans the ledger
 * over a schema in sync only, so this is reached only when
 * `_prisma_migrations` records the migration that creates the table and the
 * table is nonetheless gone: dropped by hand, or that migration marked
 * applied without running. The boot's data-migrations phase throws over that,
 * so the report is a refusal and exits 2 whatever the registry holds. The
 * registry goes through the same guard a plan does.
 */
export function describeMissingLedgerReport(entries: readonly DataMigrationEntry[]): PlanReport {
  assertDataMigrationRegistry(entries);
  const names = entries.map((entry) => entry.name).sort();
  const lines = [
    'The next api boot would REFUSE to boot: the ledger table `data_migrations` does not exist, though the schema ' +
      'ledger records the migration that creates it. The table was dropped, or that migration was marked applied ' +
      'without running; restore it, or mark the migration rolled back and run `npm run db:migrate` again.',
  ];
  if (names.length > 0) {
    lines.push('Once it exists, the boot would apply, in this order:', ...names.map(indent));
  }
  lines.push(
    '',
    names.length > 0
      ? `Data migrations: the boot would refuse; the ledger table is missing, ${names.length} pending once it exists.`
      : 'Data migrations: the boot would refuse; the ledger table is missing.',
  );
  return { lines, exitCode: 2 };
}

/**
 * The same half over a database ahead of this build. The boot skips its
 * data-migrations phase there, leaving the data to the newer build, and no CLI
 * applies data migrations, so there is no run to preview: a plan of this
 * build's registry against that ledger would be worded as the boot's ("the
 * next api boot would …") and be false. One line, exit 0; the schema's code is
 * the boot's over an ahead database.
 */
export function describeSkippedDataMigrationsReport(): PlanReport {
  return {
    lines: [
      'Data migrations: not planned; the boot skips them over a database ahead of this build, and no CLI applies ' +
        'them, so there is nothing to preview.',
    ],
    exitCode: 0,
  };
}

function closingLine(pending: number, applied: number, refusing: boolean): string {
  if (refusing) return 'Data migrations: the boot would refuse.';
  if (pending > 0) return `Data migrations: ${pending} pending.`;
  return applied > 0 ? `Data migrations: none pending, ${applied} applied.` : 'Data migrations: none pending.';
}
