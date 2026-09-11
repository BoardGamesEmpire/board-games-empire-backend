import type { DataMigrationEntry } from './data-migration-entry';
import { describeDataMigrationsReport, describeMissingLedgerReport } from './data-migrations-plan-report';
import type { DataMigrationsPlan } from './plan-data-migrations';

// The ledger half of what `npm run db:plan` prints and how it exits, over
// plans built by hand; the CLI concatenates this with the catalog's report.

const entry = (name: string): DataMigrationEntry => ({ name, revision: 1, run: async () => undefined });
const plan = (overrides: Partial<DataMigrationsPlan> = {}): DataMigrationsPlan => ({
  pending: [],
  applied: [],
  mismatched: [],
  unknown: [],
  ...overrides,
});

describe('describeDataMigrationsReport', () => {
  it('says an empty registry over an empty ledger has nothing pending and exits 0', () => {
    const report = describeDataMigrationsReport(plan());

    expect(report.exitCode).toBe(0);
    expect(report.lines).toContain('Data migrations: none pending.');
  });

  it('counts the applied entries when there are some and still exits 0', () => {
    const report = describeDataMigrationsReport(plan({ applied: ['20260901000000_first_backfill'] }));

    expect(report.exitCode).toBe(0);
    expect(report.lines).toContain('Data migrations: none pending, 1 applied.');
  });

  it('lists the pending entries in the order the next boot would apply them and exits 1', () => {
    const report = describeDataMigrationsReport(
      plan({ pending: [entry('20260901000000_first_backfill'), entry('20260902000000_second_remap')] }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toMatch(/^The next api boot would apply 2 data migration\(s\), in this order:/);
    expect(report.lines[1]).toBe('  20260901000000_first_backfill');
    expect(report.lines[2]).toBe('  20260902000000_second_remap');
    expect(report.lines).toContain('Data migrations: 2 pending.');
  });

  it('leads with the refusal when an applied entry has changed revision, and exits 2', () => {
    const report = describeDataMigrationsReport(
      plan({
        mismatched: [{ name: '20260901000000_first_backfill', codeRevision: 2, ledgerRevision: 1 }],
        pending: [entry('20260902000000_second_remap')],
      }),
    );

    expect(report.exitCode).toBe(2);
    expect(report.lines[0]).toMatch(/would REFUSE to boot/);
    expect(report.lines[1]).toContain(
      "'20260901000000_first_backfill' is at revision 2 in this build and revision 1 in the ledger",
    );
    expect(report.lines).toContain('Data migrations: the boot would refuse.');
  });

  it('names rows the registry does not know without changing the exit code', () => {
    const report = describeDataMigrationsReport(plan({ unknown: ['20260905000000_from_a_newer_build'] }));

    expect(report.exitCode).toBe(0);
    expect(report.lines.some((line) => /registry does not know/.test(line))).toBe(true);
    expect(report.lines).toContain('  20260905000000_from_a_newer_build');
  });

  it('says the ledger table is missing when the plan could not be read, and counts every entry as pending', () => {
    const report = describeMissingLedgerReport([entry('20260901000000_first_backfill')]);

    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toMatch(/data_migrations.*does not exist/);
    expect(report.lines[0]).toMatch(/npm run db:migrate/);
    expect(report.lines.at(-1)).toBe(
      'Data migrations: the ledger table is missing; 1 pending once the schema is migrated.',
    );
  });

  it('still exits 1 over a missing ledger table when the registry is empty: the schema is behind', () => {
    const report = describeMissingLedgerReport([]);

    expect(report.exitCode).toBe(1);
    expect(report.lines.at(-1)).toBe('Data migrations: the ledger table is missing; the schema is behind.');
  });
});
