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
  const refusing = plan.mismatched.length > 0;
  const pendingNames = plan.pending.map((entry) => entry.name);

  if (refusing) {
    lines.push(
      'The next api boot would REFUSE to boot: applied data migration(s) differ in revision from the ledger.',
      ...plan.mismatched.map(describeMismatch).map(indent),
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
 * The same half when the ledger table is not there, a schema behind this
 * build: every registered entry is pending, and the report says which command
 * creates the table. Exits 1 whatever the registry holds: a database without
 * the table is not converged with this build, and a reading that says the
 * schema is behind must not exit as if nothing were pending. The registry goes
 * through the same guard a plan does.
 */
export function describeMissingLedgerReport(entries: readonly DataMigrationEntry[]): PlanReport {
  assertDataMigrationRegistry(entries);
  const names = entries.map((entry) => entry.name).sort();
  const lines = [
    'The ledger table `data_migrations` does not exist yet: the schema is behind this build, and every registered ' +
      'data migration is pending until `npm run db:migrate` creates it.',
  ];
  if (names.length > 0) {
    lines.push('Pending, in the order the next api boot would apply them:', ...names.map(indent));
  }
  lines.push(
    '',
    names.length > 0
      ? `Data migrations: the ledger table is missing; ${names.length} pending once the schema is migrated.`
      : 'Data migrations: the ledger table is missing; the schema is behind.',
  );
  return { lines, exitCode: 1 };
}

function closingLine(pending: number, applied: number, refusing: boolean): string {
  if (refusing) return 'Data migrations: the boot would refuse.';
  if (pending > 0) return `Data migrations: ${pending} pending.`;
  return applied > 0 ? `Data migrations: none pending, ${applied} applied.` : 'Data migrations: none pending.';
}
