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
 * The database role in `DATABASE_URL` may not read the migration ledger. With
 * a migration credential of its own (#445), the migration database role
 * creates every table and owns it, and the other database role may use only
 * what it was granted; the first table it reads at boot is this one.
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
        'The migration database role created the tables, so it owns them, and this database role holds only what it was granted. ' +
        'Grant it SELECT, INSERT, UPDATE and DELETE on them: on tables to come with ' +
        '`ALTER DEFAULT PRIVILEGES FOR ROLE <migration database role> IN SCHEMA public GRANT ... ON TABLES`, run before the first boot, ' +
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
