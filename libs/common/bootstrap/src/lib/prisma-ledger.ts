import { readAppliedMigrations, type AppliedMigrationRow, type PrismaClient } from '@bge/database';
import type { SchemaLedger } from './ports';

/** `_prisma_migrations` through the app's own Prisma client. */
export class PrismaSchemaLedger implements SchemaLedger {
  constructor(private readonly client: Pick<PrismaClient, '$queryRaw'>) {}

  readApplied(): Promise<AppliedMigrationRow[]> {
    return readAppliedMigrations(this.client);
  }
}
