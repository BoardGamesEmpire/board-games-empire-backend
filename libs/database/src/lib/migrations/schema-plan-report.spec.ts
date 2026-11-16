import type { MigrationState } from './migration-state';
import { describeSchemaReport } from './schema-plan-report';

// The schema half of what `npm run db:plan` prints and how it exits, over
// states built by hand; the CLI prints it first and, over a schema that is
// behind or half-applied, alone.

const state = (overrides: Partial<MigrationState> & Pick<MigrationState, 'kind'>): MigrationState => ({
  pending: [],
  unknown: [],
  diverged: [],
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

  it('names the migrations this build does not know beside the pending ones, says applying makes the history rewritten, and defers deleting rows until they apply (#1148)', () => {
    // After the pending migrations apply, in a run after every row already in
    // the ledger, each unknown migration reads as a rewritten history. Before
    // then no build's migrations hold a renamed one's changes, so no DELETE.
    const report = describeSchemaReport(
      state({ kind: 'behind', pending: ['20260301_permissions'], unknown: ['20260215_renamed_away'] }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.lines).toContain('  20260215_renamed_away');
    const text = report.lines.join('\n');
    expect(text).toMatch(/the boot finds the migration history rewritten, warns, and runs the seeds/);
    expect(text).toMatch(/applying fails on them/);
    expect(text).not.toContain('DELETE FROM');
    expect(text).toMatch(/Delete no row yet: plan again after the migrations above apply/);
    expect(text).toMatch(/On a development database, .*`npm run db:reset`/);
    expect(text).not.toMatch(/left alone/);
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

  describe('a migration history that was rewritten (#1148)', () => {
    const RENAMED = '20260215_renamed_away';
    const OTHER = '20260216_other_branch';

    it('names each diverged migration, both fixes, that the boot runs the seeds and the data migrations, and exits 0', () => {
      const report = describeSchemaReport(
        state({ kind: 'diverged', unknown: [RENAMED, OTHER], diverged: [RENAMED, OTHER] }),
      );

      expect(report.exitCode).toBe(0);
      expect(report.lines).toContain(`  ${RENAMED}`);
      expect(report.lines).toContain(`  ${OTHER}`);
      const text = report.lines.join('\n');
      expect(text).toContain(`DELETE FROM _prisma_migrations WHERE migration_name = '${RENAMED}';`);
      expect(text).toContain(`DELETE FROM _prisma_migrations WHERE migration_name = '${OTHER}';`);
      // The same lines reach the boot's warning in production logs, where there is no npm and no data to spare.
      expect(text).toMatch(/On a development database, .*`npm run db:reset`/);
      expect(text).not.toMatch(/know ,/);
      expect(text).toMatch(/boot would warn and boot, running the seeds and the data migrations/);
      expect(report.lines.at(-1)).toBe(
        'Schema: diverged by 2 migration(s); the boot runs the seeds and the data migrations.',
      );
    });

    it('when also ahead, lists the newer migrations as ahead and the diverged ones in a block of their own with both fixes', () => {
      const report = describeSchemaReport(
        state({ kind: 'ahead', unknown: [RENAMED, '20260910_from_the_future'], diverged: [RENAMED] }),
      );

      expect(report.exitCode).toBe(0);
      expect(report.lines[0]).toBe('The database holds 1 migration(s) this build does not know:');
      expect(report.lines[1]).toBe('  20260910_from_the_future');
      expect(report.lines).toContain(`  ${RENAMED}`);
      const text = report.lines.join('\n');
      expect(text).toContain(`DELETE FROM _prisma_migrations WHERE migration_name = '${RENAMED}';`);
      expect(text).toContain('npm run db:reset');
      expect(report.lines.at(-1)).toBe(
        'Schema: ahead by 1 migration(s); the boot skips the seeds and the data migrations.',
      );
    });
  });
});
