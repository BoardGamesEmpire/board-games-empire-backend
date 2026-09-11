import { applyDataMigrations, DataMigrationRevisionError, type DataMigrationEntry } from '@bge/database';
import type { Logger } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The data-migration ledger against a real database (#236): `applyDataMigrations`
 * over `data_migrations` with registries the test builds, the shipped one
 * being empty. The decision table is unit-tested over fakes in `@bge/database`;
 * what only Postgres shows is that an entry's writes and its ledger row are
 * one transaction, and that a second run honours the rows the first wrote.
 * DB-only on the harness database. `data_migrations` is a table the
 * between-test sweep preserves, as it does `_prisma_migrations`, so the rows
 * each test writes are removed here; so is the probe table an entry creates,
 * which the sweep would truncate but not drop.
 */

const silent = {
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const PROBE = 'e2e_data_migration_probe';
const FIRST = '20260901000000_e2e_first';
const SECOND = '20260902000000_e2e_second';
const THIRD = '20260903000000_e2e_third';

const entry = (name: string, revision: number, run: DataMigrationEntry['run']): DataMigrationEntry => ({
  name,
  revision,
  run,
});

describe('the data-migration ledger against Postgres', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterEach(async () => {
    await db.client.$executeRawUnsafe(`DROP TABLE IF EXISTS "${PROBE}"`);
    await db.client.dataMigration.deleteMany({ where: { name: { in: [FIRST, SECOND, THIRD] } } });
  });

  afterAll(async () => {
    await db.close();
  });

  /** `count(*)` is one row, or a thrown 42P01 when the probe table is not there; there is no empty case. */
  const probeRows = async (): Promise<number> => {
    const [row] = await db.client.$queryRawUnsafe<[{ n: number }]>(`SELECT count(*)::int AS n FROM "${PROBE}"`);
    return row.n;
  };
  /** Scoped to this spec's names: the harness ledger may one day hold the shipped registry's rows too. */
  const ledgerNames = async (): Promise<string[]> =>
    (
      await db.client.dataMigration.findMany({
        where: { name: { in: [FIRST, SECOND, THIRD] } },
        orderBy: { name: 'asc' },
        select: { name: true },
      })
    ).map((r) => r.name);

  it('applies a new entry once, recording its revision and duration, and a second run applies nothing', async () => {
    let runs = 0;
    const entries = [
      entry(FIRST, 3, async (tx) => {
        runs += 1;
        await tx.$executeRawUnsafe(`CREATE TABLE "${PROBE}" (id int)`);
        await tx.$executeRawUnsafe(`INSERT INTO "${PROBE}" VALUES (1)`);
      }),
    ];

    const first = await applyDataMigrations(db.client, entries, silent);
    expect(first.applied).toEqual([FIRST]);

    const row = await db.client.dataMigration.findUniqueOrThrow({ where: { name: FIRST } });
    expect(row.revision).toBe(3);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(await probeRows()).toBe(1);

    const second = await applyDataMigrations(db.client, entries, silent);
    expect(second.applied).toEqual([]);
    expect(runs).toBe(1);
    expect(await ledgerNames()).toEqual([FIRST]);
  });

  it('rolls a failing entry back with its row, runs nothing after it, and keeps what committed before it', async () => {
    const entries = [
      entry(FIRST, 1, async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE "${PROBE}" (id int)`);
      }),
      entry(SECOND, 1, async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO "${PROBE}" VALUES (2)`);
        throw new Error('second failed');
      }),
      entry(THIRD, 1, async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO "${PROBE}" VALUES (3)`);
      }),
    ];

    await expect(applyDataMigrations(db.client, entries, silent)).rejects.toThrow('second failed');

    expect(await ledgerNames()).toEqual([FIRST]);
    expect(await probeRows()).toBe(0);
  });

  it('refuses when an applied entry changed revision, before running anything', async () => {
    await db.client.dataMigration.create({ data: { name: FIRST, revision: 1, durationMs: 0 } });
    let ran = false;
    const entries = [entry(FIRST, 2, async () => void (ran = true)), entry(SECOND, 1, async () => void (ran = true))];

    await expect(applyDataMigrations(db.client, entries, silent)).rejects.toBeInstanceOf(DataMigrationRevisionError);

    expect(ran).toBe(false);
    expect(await ledgerNames()).toEqual([FIRST]);
  });
});
