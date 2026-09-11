import { Prisma } from '../client';
import { readDataMigrationLedger } from './read-data-migration-ledger';

// The reader turns exactly one failure into "no table": Prisma's P2021.
// Anything else surfaces, or a broken ledger would read as a schema behind.

const failingWith = (error: unknown): Parameters<typeof readDataMigrationLedger>[0] =>
  ({
    dataMigration: {
      findMany: async () => {
        throw error;
      },
    },
  }) as unknown as Parameters<typeof readDataMigrationLedger>[0];

describe('readDataMigrationLedger', () => {
  it('reads the table as undefined when Prisma says it does not exist', async () => {
    const missing = new Prisma.PrismaClientKnownRequestError(
      'The table `public.data_migrations` does not exist in the current database.',
      { code: 'P2021', clientVersion: 'test' },
    );

    await expect(readDataMigrationLedger(failingWith(missing))).resolves.toBeUndefined();
  });

  it('rethrows any other known request error, and anything that is not one', async () => {
    const column = new Prisma.PrismaClientKnownRequestError('The column `revision` does not exist.', {
      code: 'P2022',
      clientVersion: 'test',
    });
    await expect(readDataMigrationLedger(failingWith(column))).rejects.toBe(column);

    const plain = new Error('connection terminated unexpectedly');
    await expect(readDataMigrationLedger(failingWith(plain))).rejects.toBe(plain);
  });
});
