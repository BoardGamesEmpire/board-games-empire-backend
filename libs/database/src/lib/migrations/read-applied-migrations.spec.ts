import { readAppliedMigrations } from './read-applied-migrations';

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
  });

  it('rethrows a ledger error that merely mentions the table, such as a missing column', async () => {
    const column = new Error(
      'Raw query failed. Code: `42703`. Message: `column "rolled_back_at" of relation "_prisma_migrations" does not exist`',
    );
    await expect(readAppliedMigrations(failingWith(column))).rejects.toBe(column);
  });
});
