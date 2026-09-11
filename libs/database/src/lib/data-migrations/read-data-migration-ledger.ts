import { PrismaError } from '@status/codes';
import { Prisma, type PrismaClient } from '../client';
import type { DataMigrationLedgerRow } from './data-migration-entry';

/**
 * The ledger's rows, or `undefined` when the table itself is not there: a
 * database whose schema is behind this build. `npm run db:plan` runs over
 * whatever schema it finds and reports that as a reading; the boot reads the
 * ledger only once the schema is in sync, where the table's absence is an
 * error. Every other failure surfaces, as `readAppliedMigrations` does for
 * the schema ledger: a broken table is not an absent one.
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
