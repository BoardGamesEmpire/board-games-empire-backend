import { classifyMigrationState, type AppliedMigrationRow } from './migration-state';

// What boot does with a database is decided from two lists: the migrations
// this build was cut from, and the rows in `_prisma_migrations`. This is that
// decision as data (#236); reading the rows is Postgres's job.

const at = new Date('2026-09-01T00:00:00Z');
const finished = (name: string): AppliedMigrationRow => ({
  migration_name: name,
  finished_at: at,
  rolled_back_at: null,
});
const unfinished = (name: string): AppliedMigrationRow => ({
  migration_name: name,
  finished_at: null,
  rolled_back_at: null,
});
const rolledBack = (name: string): AppliedMigrationRow => ({
  migration_name: name,
  finished_at: null,
  rolled_back_at: at,
});

const CHAIN = ['20260109_init', '20260219_games', '20260301_permissions'];

describe('classifyMigrationState', () => {
  it('is in sync when every expected migration has finished and nothing else is there', () => {
    const state = classifyMigrationState(CHAIN, CHAIN.map(finished));

    expect(state).toEqual({ kind: 'in-sync', pending: [], unknown: [], failed: [] });
  });

  it('is behind when expected migrations are missing, listing them in apply order', () => {
    const state = classifyMigrationState(CHAIN, [finished('20260109_init')]);

    expect(state.kind).toBe('behind');
    expect(state.pending).toEqual(['20260219_games', '20260301_permissions']);
  });

  it('treats an empty ledger as every migration pending: the fresh-database case', () => {
    const state = classifyMigrationState(CHAIN, []);

    expect(state).toEqual({ kind: 'behind', pending: CHAIN, unknown: [], failed: [] });
  });

  it('is ahead when the database holds a finished migration this build does not know', () => {
    const state = classifyMigrationState(CHAIN, [...CHAIN.map(finished), finished('20260910_from_the_future')]);

    expect(state).toEqual({ kind: 'ahead', pending: [], unknown: ['20260910_from_the_future'], failed: [] });
  });

  it('reports behind, not ahead, when both apply: pending migrations are what the migrator acts on', () => {
    const state = classifyMigrationState(CHAIN, [finished('20260109_init'), finished('20260910_from_the_future')]);

    expect(state.kind).toBe('behind');
    expect(state.pending).toEqual(['20260219_games', '20260301_permissions']);
    expect(state.unknown).toEqual(['20260910_from_the_future']);
  });

  it('is failed when a row started but neither finished nor rolled back, whatever else is true', () => {
    const state = classifyMigrationState(CHAIN, [finished('20260109_init'), unfinished('20260219_games')]);

    expect(state.kind).toBe('failed');
    expect(state.failed).toEqual(['20260219_games']);
    // Still reported, so the operator sees the whole picture in one message.
    expect(state.pending).toEqual(['20260219_games', '20260301_permissions']);
  });

  it('counts a rolled-back migration as not applied, so an expected one is pending again', () => {
    // `prisma migrate resolve --rolled-back` is how an operator clears a failed
    // migration for `migrate deploy` to retry; the row stays, marked.
    const state = classifyMigrationState(CHAIN, [finished('20260109_init'), rolledBack('20260219_games')]);

    expect(state).toEqual({
      kind: 'behind',
      pending: ['20260219_games', '20260301_permissions'],
      unknown: [],
      failed: [],
    });
  });

  it('ignores a rolled-back migration this build does not know', () => {
    const state = classifyMigrationState(CHAIN, [...CHAIN.map(finished), rolledBack('20260910_abandoned')]);

    expect(state.kind).toBe('in-sync');
    expect(state.unknown).toEqual([]);
  });
});
