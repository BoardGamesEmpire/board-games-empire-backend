import {
  isInsufficientPrivilege,
  readAppliedMigrations,
  type AppliedMigrationRow,
  type PrismaClient,
} from '@bge/database';
import { DATABASE_URL_VARIABLE } from './migration-credential';
import type { SchemaLedger } from './ports';

const LEDGER_TABLE = '_prisma_migrations';

/**
 * The database role in `DATABASE_URL` may not read the migration ledger: the
 * tables belong to another database role, and this one may use only what it
 * was granted. With a migration credential of its own (#445) that owner is
 * the migration database role; without one, whoever migrated or restored the
 * database. Every process reads this table first, and none of them knows
 * which, since only the api is given the migration credential.
 */
export class LedgerAccessDeniedError extends Error {
  constructor(
    readonly databaseRole: string | undefined,
    options?: { readonly cause?: unknown },
  ) {
    const role = databaseRole
      ? `the database role '${databaseRole}' in ${DATABASE_URL_VARIABLE}`
      : `the database role in ${DATABASE_URL_VARIABLE}`;
    super(
      `Refusing to boot: ${role} may not read ${LEDGER_TABLE}, which every process role reads at boot. ` +
        'The tables belong to another database role, the migration database role when the api has a migration ' +
        'credential of its own, and this one holds only what it was granted. ' +
        'Grant it SELECT, INSERT, UPDATE and DELETE on them: on tables to come with ' +
        "`ALTER DEFAULT PRIVILEGES FOR ROLE <the tables' owner> IN SCHEMA public GRANT ... ON TABLES`, run before the first boot, " +
        'and on tables that already exist with `GRANT ... ON ALL TABLES IN SCHEMA public`. ' +
        'docs/BOOTSTRAP.md, "The migration credential", has the statements.',
      options,
    );
    this.name = 'LedgerAccessDeniedError';
  }
}

export interface PrismaSchemaLedgerOptions {
  /** The database role `DATABASE_URL` connects as, named when the read is refused. */
  readonly databaseRole?: string;
}

/** `_prisma_migrations` through the app's own Prisma client. */
export class PrismaSchemaLedger implements SchemaLedger {
  constructor(
    private readonly client: Pick<PrismaClient, '$queryRaw'>,
    private readonly options: PrismaSchemaLedgerOptions = {},
  ) {}

  async readApplied(): Promise<AppliedMigrationRow[]> {
    try {
      return await readAppliedMigrations(this.client);
    } catch (error) {
      if (isInsufficientPrivilege(error)) {
        throw new LedgerAccessDeniedError(this.options.databaseRole, { cause: error });
      }

      throw error;
    }
  }
}
