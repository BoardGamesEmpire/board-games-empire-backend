import type { DataMigrationEntry, DataMigrationLedgerRow } from './data-migration-entry';
import { planDataMigrations } from './plan-data-migrations';

// The ledger decision, pure, one row per case (#236): what the registry holds
// against what `data_migrations` holds. The read and the writes are
// `applyDataMigrations`, exercised against Postgres in apps/api-e2e.

const noop = async (): Promise<void> => undefined;
const entry = (name: string, revision = 1): DataMigrationEntry => ({ name, revision, run: noop });
const row = (name: string, revision = 1): DataMigrationLedgerRow => ({ name, revision });

const FIRST = '20260901000000_first_backfill';
const SECOND = '20260902000000_second_remap';
const THIRD = '20260903000000_third_sweep';

describe('planDataMigrations', () => {
  it('has nothing to say over an empty registry and an empty ledger', () => {
    expect(planDataMigrations([], [])).toEqual({ pending: [], applied: [], mismatched: [], unknown: [] });
  });

  it('lists every entry without a row as pending, in name order whatever the registry order', () => {
    const plan = planDataMigrations([entry(THIRD), entry(FIRST), entry(SECOND)], []);

    expect(plan.pending.map((e) => e.name)).toEqual([FIRST, SECOND, THIRD]);
    expect(plan.applied).toEqual([]);
  });

  it('does not run an applied entry again when the ledger carries its revision', () => {
    const plan = planDataMigrations([entry(FIRST, 2), entry(SECOND)], [row(FIRST, 2)]);

    expect(plan.applied).toEqual([FIRST]);
    expect(plan.pending.map((e) => e.name)).toEqual([SECOND]);
    expect(plan.mismatched).toEqual([]);
  });

  it('reports an applied entry whose code revision differs from the ledger, and neither re-runs nor ignores it', () => {
    const plan = planDataMigrations([entry(FIRST, 3), entry(SECOND)], [row(FIRST, 2)]);

    expect(plan.mismatched).toEqual([{ name: FIRST, codeRevision: 3, ledgerRevision: 2 }]);
    expect(plan.applied).toEqual([]);
    expect(plan.pending.map((e) => e.name)).toEqual([SECOND]);
  });

  it('reports rows the registry does not know, sorted, without touching the rest of the plan', () => {
    const plan = planDataMigrations([entry(FIRST)], [row(FIRST), row(THIRD), row(SECOND)]);

    expect(plan.unknown).toEqual([SECOND, THIRD]);
    expect(plan.applied).toEqual([FIRST]);
    expect(plan.pending).toEqual([]);
  });

  it('refuses a registry that names an entry twice', () => {
    expect(() => planDataMigrations([entry(FIRST), entry(FIRST, 2)], [])).toThrow(
      /'20260901000000_first_backfill' twice/,
    );
  });

  it('refuses a name that is not timestamp-prefixed snake case, since order is the name', () => {
    expect(() => planDataMigrations([entry('first_backfill')], [])).toThrow(/first_backfill/);
    expect(() => planDataMigrations([entry('20260901_first_backfill')], [])).toThrow(/20260901_first_backfill/);
    expect(() => planDataMigrations([entry('20260901000000_First-Backfill')], [])).toThrow(/First-Backfill/);
  });

  it('refuses a revision that is not a positive integer, or one above what the ledger column holds', () => {
    expect(() => planDataMigrations([entry(FIRST, 0)], [])).toThrow(/revision/);
    expect(() => planDataMigrations([entry(FIRST, 1.5)], [])).toThrow(/revision/);
    expect(() => planDataMigrations([entry(FIRST, 2_147_483_648)], [])).toThrow(/2147483647/);
    expect(planDataMigrations([entry(FIRST, 2_147_483_647)], []).pending.map((e) => e.name)).toEqual([FIRST]);
  });
});
