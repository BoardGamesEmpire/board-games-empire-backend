import { isInsufficientPrivilege, readAppliedMigrations } from './read-applied-migrations';

// The ledger reader turns exactly one failure into "no rows": the table is
// not there. Every other failure must surface, or boot would misread a broken
// ledger as a fresh database and try to migrate over it.

const failingWith = (error: unknown): Parameters<typeof readAppliedMigrations>[0] =>
  ({
    $queryRaw: async () => {
      throw error;
    },
  }) as unknown as Parameters<typeof readAppliedMigrations>[0];

describe('readAppliedMigrations', () => {
  it('treats a missing ledger table as no rows, wherever the driver puts the SQLSTATE', async () => {
    const nested = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { code: '42P01', message: 'relation "_prisma_migrations" does not exist' },
    });
    await expect(readAppliedMigrations(failingWith(nested))).resolves.toEqual([]);

    const inMessage = new Error(
      'Raw query failed. Code: `42P01`. Message: `relation "e2e._prisma_migrations" does not exist`',
    );
    await expect(readAppliedMigrations(failingWith(inMessage))).resolves.toEqual([]);

    const fromAdapter = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode: '42P01' } } },
    });
    await expect(readAppliedMigrations(failingWith(fromAdapter))).resolves.toEqual([]);
  });

  it('rethrows a ledger error that merely mentions the table, such as a missing column', async () => {
    const column = new Error(
      'Raw query failed. Code: `42703`. Message: `column "rolled_back_at" of relation "_prisma_migrations" does not exist`',
    );
    await expect(readAppliedMigrations(failingWith(column))).rejects.toBe(column);
  });
});

// A database role refused the ledger: the boot names the role and the grants,
// where the raw error would name neither.
describe('isInsufficientPrivilege', () => {
  const permissionDenied = 'permission denied for table _prisma_migrations';

  it("recognises Postgres's insufficient_privilege wherever the driver puts the SQLSTATE", () => {
    const nested = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { code: '42501', message: permissionDenied },
    });
    const inMessage = new Error(`Raw query failed. Code: \`42501\`. Message: \`${permissionDenied}\``);
    const fromAdapter = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode: '42501' } } },
    });

    expect(isInsufficientPrivilege(nested)).toBe(true);
    expect(isInsufficientPrivilege(inMessage)).toBe(true);
    expect(isInsufficientPrivilege(fromAdapter)).toBe(true);
  });

  it('is false for any other failure, a missing ledger included', () => {
    const missing = new Error(
      'Raw query failed. Code: `42P01`. Message: `relation "_prisma_migrations" does not exist`',
    );

    expect(isInsufficientPrivilege(missing)).toBe(false);
    expect(isInsufficientPrivilege(new Error('Connection terminated unexpectedly'))).toBe(false);
    expect(isInsufficientPrivilege(undefined)).toBe(false);
  });
});
