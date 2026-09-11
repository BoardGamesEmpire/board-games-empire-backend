import type { MigrationState } from './migration-state';
import { describeSchemaReport } from './schema-plan-report';

// The schema half of what `npm run db:plan` prints and how it exits, over
// states built by hand; the CLI prints it first and, over a schema that is
// behind or half-applied, alone.

const state = (overrides: Partial<MigrationState> & Pick<MigrationState, 'kind'>): MigrationState => ({
  pending: [],
  unknown: [],
  failed: [],
  ...overrides,
});

describe('describeSchemaReport', () => {
  it('says an in-sync schema in one line and exits 0', () => {
    const report = describeSchemaReport(state({ kind: 'in-sync' }));

    expect(report.exitCode).toBe(0);
    expect(report.lines).toEqual(['Schema: in sync with this build.']);
  });

  it('lists the pending migrations in apply order when behind, says nothing else is planned, and exits 1', () => {
    const report = describeSchemaReport(state({ kind: 'behind', pending: ['20260219_games', '20260301_permissions'] }));

    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toBe('The next api boot would apply 2 migration(s) before the seeds, in this order:');
    expect(report.lines[1]).toBe('  20260219_games');
    expect(report.lines[2]).toBe('  20260301_permissions');
    expect(report.lines.some((line) => /not planned here/.test(line) && /npm run db:migrate/.test(line))).toBe(true);
    expect(report.lines.at(-1)).toBe('Schema: behind by 2 migration(s).');
  });

  it('names the migrations this build does not know beside the pending ones when both apply', () => {
    const report = describeSchemaReport(
      state({ kind: 'behind', pending: ['20260301_permissions'], unknown: ['20260910_from_the_future'] }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.lines.some((line) => /does not know/.test(line))).toBe(true);
    expect(report.lines).toContain('  20260910_from_the_future');
    expect(report.lines.at(-1)).toBe('Schema: behind by 1 migration(s).');
  });

  it('says the boot would skip the seeds and the data migrations when ahead, and exits 0', () => {
    const report = describeSchemaReport(state({ kind: 'ahead', unknown: ['20260910_from_the_future'] }));

    expect(report.exitCode).toBe(0);
    expect(report.lines[0]).toBe('The database holds 1 migration(s) this build does not know:');
    expect(report.lines[1]).toBe('  20260910_from_the_future');
    expect(
      report.lines.some((line) => /npm run db:seed/.test(line) && /does not count toward the exit code/.test(line)),
    ).toBe(true);
    expect(report.lines.at(-1)).toBe(
      'Schema: ahead by 1 migration(s); the boot skips the seeds and the data migrations.',
    );
  });

  it('leads with the refusal over a migration that started and never finished, names the resolve command, and exits 2', () => {
    const report = describeSchemaReport(
      state({ kind: 'failed', failed: ['20260219_games'], pending: ['20260219_games', '20260301_permissions'] }),
    );

    expect(report.exitCode).toBe(2);
    expect(report.lines[0]).toBe('The next api boot would REFUSE to boot: 1 migration(s) started but did not finish.');
    expect(report.lines[1]).toBe('  20260219_games');
    expect(report.lines.some((line) => line.includes('`prisma migrate resolve --rolled-back 20260219_games`'))).toBe(
      true,
    );
    expect(report.lines.some((line) => /still running/.test(line))).toBe(true);
    expect(report.lines.at(-1)).toBe('Schema: the boot would refuse.');
  });
});
