import { PrismaError } from '@status/codes';
import { Prisma, type PrismaClient } from '../client';
import type { DataMigrationLedgerRow } from './data-migration-entry';

/**
 * The ledger's rows, or `undefined` when the table itself is not there. Both
 * readers reach this only once `_prisma_migrations` says the schema is
 * current (the boot, and `npm run db:plan`, which plans nothing over a schema
 * that is behind), so an absent table is a dropped one, or a migration marked
 * applied without running: the boot refuses, and the plan says it would.
 * Every other failure surfaces, as `readAppliedMigrations` does for the
 * schema ledger: a broken table is not an absent one.
 */
export async function readDataMigrationLedger(
  client: Pick<PrismaClient, 'dataMigration'>,
): Promise<DataMigrationLedgerRow[] | undefined> {
  try {
    return await client.dataMigration.findMany({ select: { name: true, revision: true } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PrismaError.TableDoesNotExist) {
      return undefined;
    }
    throw error;
  }
}
