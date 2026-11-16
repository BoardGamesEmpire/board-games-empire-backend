import { classifyMigrationState, type AppliedMigrationRow } from './migration-state';

// What boot does with a database is decided from two lists: the migrations
// this build was cut from, and the rows in `_prisma_migrations`. This is that
// decision as data (#236); reading the rows is Postgres's job.

const at = new Date('2026-09-01T00:00:00Z');
const finished = (name: string): AppliedMigrationRow => ({
  migration_name: name,
  started_at: at,
  finished_at: at,
  rolled_back_at: null,
});
const unfinished = (name: string): AppliedMigrationRow => ({
  migration_name: name,
  started_at: at,
  finished_at: null,
  rolled_back_at: null,
});
const rolledBack = (name: string): AppliedMigrationRow => ({
  migration_name: name,
  started_at: at,
  finished_at: null,
  rolled_back_at: at,
});
/** A row whose migration started and finished at the given instants. */
const ranAt = (name: string, startedIso: string, finishedIso: string): AppliedMigrationRow => ({
  migration_name: name,
  started_at: new Date(startedIso),
  finished_at: new Date(finishedIso),
  rolled_back_at: null,
});
/** A row as one run stamps it: started and finished at the same instant. */
const finishedAt = (name: string, iso: string): AppliedMigrationRow => ({
  migration_name: name,
  started_at: new Date(iso),
  finished_at: new Date(iso),
  rolled_back_at: null,
});

const CHAIN = ['20260109_init', '20260219_games', '20260301_permissions'];

describe('classifyMigrationState', () => {
  it('is in sync when every expected migration has finished and nothing else is there', () => {
    const state = classifyMigrationState(CHAIN, CHAIN.map(finished));

    expect(state).toEqual({ kind: 'in-sync', pending: [], unknown: [], diverged: [], failed: [] });
  });

  it('is behind when expected migrations are missing, listing them in apply order', () => {
    const state = classifyMigrationState(CHAIN, [finished('20260109_init')]);

    expect(state.kind).toBe('behind');
    expect(state.pending).toEqual(['20260219_games', '20260301_permissions']);
  });

  it('treats an empty ledger as every migration pending: the fresh-database case', () => {
    const state = classifyMigrationState(CHAIN, []);

    expect(state).toEqual({ kind: 'behind', pending: CHAIN, unknown: [], diverged: [], failed: [] });
  });

  it('is ahead when the database holds a finished migration this build does not know', () => {
    const state = classifyMigrationState(CHAIN, [...CHAIN.map(finished), finished('20260910_from_the_future')]);

    expect(state).toEqual({
      kind: 'ahead',
      pending: [],
      unknown: ['20260910_from_the_future'],
      diverged: [],
      failed: [],
    });
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
      diverged: [],
      failed: [],
    });
  });

  it('ignores a rolled-back migration this build does not know', () => {
    const state = classifyMigrationState(CHAIN, [...CHAIN.map(finished), rolledBack('20260910_abandoned')]);

    expect(state.kind).toBe('in-sync');
    expect(state.unknown).toEqual([]);
  });

  // A migration renamed or deleted on master, or another branch's migration
  // left by switching branches over one database, finished before migrations
  // this build knows. A rollback leaves the newer build's migrations finishing
  // last. Decided by `finished_at`, not by name: migrations reach master out of
  // name order, so a newer build's migration can be named older (#1148).
  describe('a migration history that was rewritten (#1148)', () => {
    const LATER = '2026-09-02T00:00:00Z';

    it('is diverged when a migration this build knows finished after the unknown one: a renamed or deleted migration (#1148)', () => {
      const state = classifyMigrationState(CHAIN, [
        finishedAt('20260215_renamed_away', '2026-09-01T00:00:00Z'),
        ...CHAIN.map((name) => finishedAt(name, LATER)),
      ]);

      expect(state).toEqual({
        kind: 'diverged',
        pending: [],
        unknown: ['20260215_renamed_away'],
        diverged: ['20260215_renamed_away'],
        failed: [],
      });
    });

    it('is ahead, not diverged, when the unknown migration is named older but finished after every known one: a rollback past an out-of-order merge', () => {
      const state = classifyMigrationState(CHAIN, [
        ...CHAIN.map((name) => finishedAt(name, '2026-09-01T00:00:00Z')),
        finishedAt('20260101_merged_late', LATER),
      ]);

      expect(state.kind).toBe('ahead');
      expect(state.unknown).toEqual(['20260101_merged_late']);
      expect(state.diverged).toEqual([]);
    });

    it('is ahead when the unknown migration finished at the same instant as a known one', () => {
      // One `migrate deploy` stamps several rows; the same instant is not "after".
      const state = classifyMigrationState(CHAIN, [
        ...CHAIN.map((name) => finishedAt(name, LATER)),
        finishedAt('20260910_from_the_future', LATER),
      ]);

      expect(state.kind).toBe('ahead');
      expect(state.diverged).toEqual([]);
    });

    it('ignores a rolled-back known row when deciding diverged', () => {
      const state = classifyMigrationState(CHAIN, [
        finishedAt('20260109_init', '2026-08-01T00:00:00Z'),
        finishedAt('20260219_games', '2026-08-01T00:00:00Z'),
        finishedAt('20260301_permissions', '2026-08-01T00:00:00Z'),
        finishedAt('20260910_from_the_future', '2026-09-01T00:00:00Z'),
        {
          migration_name: '20260301_permissions',
          started_at: new Date(LATER),
          finished_at: new Date(LATER),
          rolled_back_at: new Date(LATER),
        },
      ]);

      expect(state.kind).toBe('ahead');
      expect(state.diverged).toEqual([]);
    });

    it('is ahead when the database holds both a diverged and a newer unknown migration, listing the diverged one', () => {
      const state = classifyMigrationState(CHAIN, [
        finishedAt('20260215_renamed_away', '2026-09-01T00:00:00Z'),
        ...CHAIN.map((name) => finishedAt(name, LATER)),
        finishedAt('20260910_from_the_future', '2026-09-03T00:00:00Z'),
      ]);

      expect(state.kind).toBe('ahead');
      expect(state.unknown).toEqual(['20260215_renamed_away', '20260910_from_the_future']);
      expect(state.diverged).toEqual(['20260215_renamed_away']);
    });

    // One `migrate deploy` applies its pending migrations back to back, in
    // name order: measured over the whole chain, under 2ms from one finishing
    // to the next starting. So a newer build that brings a migration merged
    // out of name order applies it BEFORE later-named ones in the same run,
    // and a rollback to the build that lacks only it must still read ahead.
    it('is ahead, not diverged, after a rollback past a migration merged out of name order that one deploy applied before later-named ones (#1148)', () => {
      const state = classifyMigrationState(CHAIN, [
        ranAt('20260109_init', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.100Z'),
        ranAt('20260219_games', '2026-08-01T00:00:00.101Z', '2026-08-01T00:00:00.200Z'),
        ranAt('20260220_merged_out_of_order', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.100Z'),
        ranAt('20260301_permissions', '2026-09-01T00:00:00.101Z', '2026-09-01T00:00:00.200Z'),
      ]);

      expect(state.kind).toBe('ahead');
      expect(state.diverged).toEqual([]);
    });

    it('is diverged when the migrations this build knows were applied by a run that started more than ten seconds after it finished', () => {
      const state = classifyMigrationState(CHAIN, [
        ranAt('20260109_init', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.100Z'),
        ranAt('20260219_games', '2026-08-01T00:00:00.101Z', '2026-08-01T00:00:00.200Z'),
        ranAt('20260220_renamed_away', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.100Z'),
        ranAt('20260301_permissions', '2026-09-01T00:00:10.101Z', '2026-09-01T00:00:10.200Z'),
      ]);

      expect(state.kind).toBe('diverged');
      expect(state.diverged).toEqual(['20260220_renamed_away']);
    });

    it('is behind when migrations are pending, whatever the unknown ones are', () => {
      const state = classifyMigrationState(CHAIN, [
        finishedAt('20260109_init', LATER),
        finishedAt('20260108_renamed_away', '2026-09-01T00:00:00Z'),
      ]);

      expect(state.kind).toBe('behind');
      expect(state.pending).toEqual(['20260219_games', '20260301_permissions']);
      expect(state.diverged).toEqual(['20260108_renamed_away']);
    });
  });
});
