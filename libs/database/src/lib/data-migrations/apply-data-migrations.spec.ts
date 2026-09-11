import type { Logger } from '@nestjs/common';
import { Prisma } from '../client';
import { applyDataMigrations, DataMigrationRevisionError, type DataMigrationsClient } from './apply-data-migrations';
import type { DataMigrationEntry, DataMigrationLedgerRow } from './data-migration-entry';

// The apply loop over a fake client: one transaction per entry, the entry's
// `run` and its ledger row inside it, nothing before a refusal. What only
// Postgres can show, that a failed entry's writes roll back with its row, is
// apps/api-e2e/src/database/data-migrations.spec.ts.

const FIRST = '20260901000000_first_backfill';
const SECOND = '20260902000000_second_remap';

interface FakeTx {
  readonly id: number;
  readonly created: Array<{ name: string; revision: number; durationMs: number }>;
}

/** Records every transaction and what was created inside it; `run` sees the same object the row is written on. */
function fakeClient(rows: DataMigrationLedgerRow[] | (() => Promise<DataMigrationLedgerRow[]>)) {
  const transactions: FakeTx[] = [];
  const client = {
    dataMigration: { findMany: typeof rows === 'function' ? rows : async () => rows.map((row) => ({ ...row })) },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const tx: FakeTx & { dataMigration: { create: (args: { data: FakeTx['created'][number] }) => Promise<void> } } = {
        id: transactions.length + 1,
        created: [],
        dataMigration: {
          create: async ({ data }) => {
            tx.created.push(data);
          },
        },
      };
      transactions.push(tx);
      return fn(tx);
    },
  };
  return { client: client as unknown as DataMigrationsClient, transactions };
}

function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: unknown) => void lines.push(`${level}: ${String(message)}`);
  return {
    lines,
    log: push('log'),
    warn: push('warn'),
    debug: push('debug'),
    error: push('error'),
  } as unknown as Logger & {
    readonly lines: string[];
  };
}

const entry = (name: string, revision: number, run: DataMigrationEntry['run']): DataMigrationEntry => ({
  name,
  revision,
  run,
});

describe('applyDataMigrations', () => {
  it('applies each pending entry in its own transaction, in name order, and writes its row on the same transaction', async () => {
    const ran: Array<{ name: string; tx: unknown }> = [];
    const { client, transactions } = fakeClient([]);
    const entries = [
      entry(SECOND, 1, async (tx) => void ran.push({ name: SECOND, tx })),
      entry(FIRST, 2, async (tx) => void ran.push({ name: FIRST, tx })),
    ];

    const result = await applyDataMigrations(client, entries, recordingLogger());

    expect(result).toEqual({ applied: [FIRST, SECOND], unknown: [], invalidated: false });
    expect(ran.map((r) => r.name)).toEqual([FIRST, SECOND]);
    expect(transactions).toHaveLength(2);
    expect(ran[0]?.tx).toBe(transactions[0]);
    expect(ran[1]?.tx).toBe(transactions[1]);
    expect(transactions[0]?.created).toEqual([{ name: FIRST, revision: 2, durationMs: expect.any(Number) }]);
    expect(transactions[1]?.created).toEqual([{ name: SECOND, revision: 1, durationMs: expect.any(Number) }]);
    expect(Number.isInteger(transactions[0]?.created[0]?.durationMs)).toBe(true);
  });

  it('opens no transaction when nothing is pending, and says so once', async () => {
    const { client, transactions } = fakeClient([{ name: FIRST, revision: 1 }]);
    const logger = recordingLogger();

    const result = await applyDataMigrations(client, [entry(FIRST, 1, async () => undefined)], logger);

    expect(result.applied).toEqual([]);
    expect(transactions).toEqual([]);
    expect(logger.lines.filter((line) => /nothing pending|none pending/i.test(line))).toHaveLength(1);
  });

  it('refuses on a revision mismatch before running anything, naming the entry and both revisions', async () => {
    const { client, transactions } = fakeClient([{ name: FIRST, revision: 1 }]);
    let secondRan = false;
    const entries = [entry(FIRST, 2, async () => undefined), entry(SECOND, 1, async () => void (secondRan = true))];

    const run = applyDataMigrations(client, entries, recordingLogger());

    await expect(run).rejects.toBeInstanceOf(DataMigrationRevisionError);
    await expect(run).rejects.toThrow(/20260901000000_first_backfill.*revision 2.*revision 1/);
    expect(transactions).toEqual([]);
    expect(secondRan).toBe(false);
  });

  it('refuses when the ledger table does not exist, naming the schema as behind, and opens no transaction', async () => {
    const missing = new Prisma.PrismaClientKnownRequestError('The table does not exist in the current database.', {
      code: 'P2021',
      clientVersion: 'test',
    });
    const { client, transactions } = fakeClient(async () => {
      throw missing;
    });

    await expect(
      applyDataMigrations(client, [entry(FIRST, 1, async () => undefined)], recordingLogger()),
    ).rejects.toThrow(/data_migrations table does not exist.*schema is behind/);
    expect(transactions).toEqual([]);
  });

  it('stops at the first entry that throws: its row is not written, later entries do not run, earlier ones stay applied', async () => {
    const { client, transactions } = fakeClient([]);
    const boom = new Error('backfill failed');
    let thirdRan = false;
    const entries = [
      entry(FIRST, 1, async () => undefined),
      entry(SECOND, 1, async () => {
        throw boom;
      }),
      entry('20260903000000_third_sweep', 1, async () => void (thirdRan = true)),
    ];

    await expect(applyDataMigrations(client, entries, recordingLogger())).rejects.toBe(boom);

    expect(transactions).toHaveLength(2);
    expect(transactions[0]?.created.map((row) => row.name)).toEqual([FIRST]);
    expect(transactions[1]?.created).toEqual([]);
    expect(thirdRan).toBe(false);
  });

  it('warns about ledger rows the registry does not know and returns them, leaving them alone', async () => {
    const { client, transactions } = fakeClient([{ name: '20260905000000_from_a_newer_build', revision: 1 }]);
    const logger = recordingLogger();

    const result = await applyDataMigrations(client, [], logger);

    expect(result.unknown).toEqual(['20260905000000_from_a_newer_build']);
    expect(transactions).toEqual([]);
    expect(
      logger.lines.some((line) => line.startsWith('warn: ') && line.includes('20260905000000_from_a_newer_build')),
    ).toBe(true);
    expect(logger.lines).toContain(
      'log: Data migrations: none pending (0 applied, 1 row(s) this build does not know).',
    );
  });
});

describe('applyDataMigrations and the invalidation port', () => {
  it('calls the port once after the entries applied, and reports it', async () => {
    const { client } = fakeClient([]);
    let calls = 0;
    const entries = [entry(FIRST, 1, async () => undefined), entry(SECOND, 1, async () => undefined)];

    const result = await applyDataMigrations(client, entries, recordingLogger(), {
      invalidate: async () => void (calls += 1),
    });

    expect(calls).toBe(1);
    expect(result).toEqual({ applied: [FIRST, SECOND], unknown: [], invalidated: true });
  });

  it('leaves the port alone when nothing was pending', async () => {
    const { client } = fakeClient([{ name: FIRST, revision: 1 }]);
    let calls = 0;

    const result = await applyDataMigrations(client, [entry(FIRST, 1, async () => undefined)], recordingLogger(), {
      invalidate: async () => void (calls += 1),
    });

    expect(calls).toBe(0);
    expect(result.invalidated).toBe(false);
  });

  it('warns and returns when the port fails, the entries being committed', async () => {
    const { client, transactions } = fakeClient([]);
    const logger = recordingLogger();

    const result = await applyDataMigrations(client, [entry(FIRST, 1, async () => undefined)], logger, {
      invalidate: async () => {
        throw new Error('redis is down');
      },
    });

    expect(result).toEqual({ applied: [FIRST], unknown: [], invalidated: false });
    expect(transactions[0]?.created.map((row) => row.name)).toEqual([FIRST]);
    expect(logger.lines.some((line) => /^warn: .*invalidation port failed.*redis is down/.test(line))).toBe(true);
  });

  it('warns that the caches were not touched when entries applied and no port was given', async () => {
    const { client } = fakeClient([]);
    const logger = recordingLogger();

    await applyDataMigrations(client, [entry(FIRST, 1, async () => undefined)], logger);

    expect(logger.lines.some((line) => /^warn: .*no invalidation port/.test(line))).toBe(true);
  });

  it('flushes for the entries that committed when a later one fails, then rethrows that failure', async () => {
    const { client, transactions } = fakeClient([]);
    const boom = new Error('second failed');
    let calls = 0;
    const entries = [
      entry(FIRST, 1, async () => undefined),
      entry(SECOND, 1, async () => {
        throw boom;
      }),
    ];

    await expect(
      applyDataMigrations(client, entries, recordingLogger(), { invalidate: async () => void (calls += 1) }),
    ).rejects.toBe(boom);

    expect(calls).toBe(1);
    expect(transactions[0]?.created.map((row) => row.name)).toEqual([FIRST]);
  });

  it('leaves the port alone when the first entry fails, nothing having committed', async () => {
    const { client } = fakeClient([]);
    let calls = 0;
    const entries = [
      entry(FIRST, 1, async () => {
        throw new Error('first failed');
      }),
    ];

    await expect(
      applyDataMigrations(client, entries, recordingLogger(), { invalidate: async () => void (calls += 1) }),
    ).rejects.toThrow('first failed');

    expect(calls).toBe(0);
  });

  it("keeps the entry's failure when the flush after it fails too, and warns", async () => {
    const { client } = fakeClient([]);
    const boom = new Error('second failed');
    const logger = recordingLogger();
    const entries = [
      entry(FIRST, 1, async () => undefined),
      entry(SECOND, 1, async () => {
        throw boom;
      }),
    ];

    await expect(
      applyDataMigrations(client, entries, logger, {
        invalidate: async () => {
          throw new Error('redis is down');
        },
      }),
    ).rejects.toBe(boom);

    expect(logger.lines.some((line) => /^warn: .*invalidation port failed.*redis is down/.test(line))).toBe(true);
  });
});

describe('applyDataMigrations, when the commit fails', () => {
  it('does not say an entry applied when its transaction did not commit', async () => {
    const rows: DataMigrationLedgerRow[] = [];
    const commitFailure = new Error('Transaction already closed');
    const client = {
      dataMigration: { findMany: async () => rows },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        await fn({ dataMigration: { create: async () => undefined } });
        throw commitFailure;
      },
    } as unknown as DataMigrationsClient;
    const logger = recordingLogger();

    await expect(applyDataMigrations(client, [entry(FIRST, 1, async () => undefined)], logger)).rejects.toBe(
      commitFailure,
    );

    expect(logger.lines.some((line) => /applied at revision/.test(line))).toBe(false);
  });
});
