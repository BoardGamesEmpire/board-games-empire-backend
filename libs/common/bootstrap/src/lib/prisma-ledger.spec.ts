import { LedgerAccessDeniedError, PrismaSchemaLedger } from './prisma-ledger';

// With a migration credential of its own, the migration database role creates
// and owns `_prisma_migrations`, and every process role reads it through
// DATABASE_URL. Missing grants first show up at that read; the raw Postgres
// error names neither the role nor the fix.

const failingWith = (error: unknown): ConstructorParameters<typeof PrismaSchemaLedger>[0] =>
  ({
    $queryRaw: async () => {
      throw error;
    },
  }) as unknown as ConstructorParameters<typeof PrismaSchemaLedger>[0];

const permissionDenied = 'permission denied for table _prisma_migrations';

describe('PrismaSchemaLedger', () => {
  it('turns a refused read into a refusal naming the database role in DATABASE_URL, the table, and the fix', async () => {
    const denied = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { code: '42501', message: permissionDenied },
    });
    const ledger = new PrismaSchemaLedger(failingWith(denied), { databaseRole: 'bge_app' });

    const read = ledger.readApplied();

    await expect(read).rejects.toBeInstanceOf(LedgerAccessDeniedError);
    await expect(read).rejects.toThrow(/database role 'bge_app' in DATABASE_URL/);
    await expect(read).rejects.toThrow(/_prisma_migrations/);
    await expect(read).rejects.toThrow(/ALTER DEFAULT PRIVILEGES FOR ROLE/);
    await expect(read).rejects.toThrow(/docs\/BOOTSTRAP\.md/);
  });

  it("recognises the SQLSTATE where the driver adapter keeps Postgres's own code", async () => {
    const denied = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: {
        driverAdapterError: { cause: { kind: 'postgres', originalCode: '42501', originalMessage: permissionDenied } },
      },
    });
    const ledger = new PrismaSchemaLedger(failingWith(denied), { databaseRole: 'bge_app' });

    await expect(ledger.readApplied()).rejects.toBeInstanceOf(LedgerAccessDeniedError);
  });

  it('recognises the SQLSTATE where Prisma puts it in the message', async () => {
    const denied = new Error(`Raw query failed. Code: \`42501\`. Message: \`${permissionDenied}\``);
    const ledger = new PrismaSchemaLedger(failingWith(denied), { databaseRole: 'bge_app' });

    await expect(ledger.readApplied()).rejects.toBeInstanceOf(LedgerAccessDeniedError);
  });

  it('rethrows any other failure unchanged', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const ledger = new PrismaSchemaLedger(failingWith(lost), { databaseRole: 'bge_app' });

    await expect(ledger.readApplied()).rejects.toBe(lost);
  });
});
