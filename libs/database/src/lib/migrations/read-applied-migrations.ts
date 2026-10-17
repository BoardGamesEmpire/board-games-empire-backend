import { PG } from '@status/codes';
import type { Prisma, PrismaClient } from '../client';
import type { AppliedMigrationRow } from './migration-state';
/**
 * Postgres's `undefined_table` text for the ledger, schema-qualified or not.
 * The lookbehind keeps `undefined_column` out, whose text is `column "x" of
 * relation "_prisma_migrations" does not exist`: a broken ledger is not an
 * absent one, and must surface rather than read as a fresh database.
 */
const LEDGER_MISSING = /(?<!of )relation "(?:[^"]*\.)?_prisma_migrations" does not exist/;

type Queryable = Pick<PrismaClient, '$queryRaw'> | Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * The rows of `_prisma_migrations`, or none when the table itself is missing —
 * a database `migrate deploy` has never touched, which boot treats as every
 * migration pending rather than as an error.
 */
export async function readAppliedMigrations(client: Queryable): Promise<AppliedMigrationRow[]> {
  try {
    return await client.$queryRaw<AppliedMigrationRow[]>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM _prisma_migrations
      ORDER BY migration_name`;
  } catch (error) {
    if (isUndefinedTable(error)) {
      return [];
    }

    throw error;
  }
}

/**
 * Postgres refused the read for want of a privilege (`insufficient_privilege`):
 * the database role reading the ledger was granted nothing on the table that
 * another database role, the one that migrated, created and owns.
 */
export function isInsufficientPrivilege(error: unknown): boolean {
  return carriesSqlState(error, PG.InsufficientPrivilege);
}

/**
 * `undefined_table`: the ledger does not exist yet. Also by Postgres's wording
 * of "that table is not there", which carries no SQLSTATE.
 */
function isUndefinedTable(error: unknown): boolean {
  return carriesSqlState(error, PG.UndefinedTable, (message) => LEDGER_MISSING.test(message));
}

/**
 * The driver adapter surfaces the SQLSTATE in more than one position (see
 * `isDeadlockError` in `../utils` for the same problem with 40P01), so the
 * error graph is walked for it; a message is consulted only for Prisma's
 * wording of the code ("Raw query failed. Code: `42P01`. Message: `...`"),
 * and for whatever `messageSays` accepts.
 */
function carriesSqlState(error: unknown, sqlState: string, messageSays?: (message: string) => boolean): boolean {
  const inMessage = `Code: \`${sqlState}\``;
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (record['code'] === sqlState || record['sqlState'] === sqlState || record['originalCode'] === sqlState) {
      return true;
    }
    if (
      typeof record['message'] === 'string' &&
      (record['message'].includes(inMessage) || messageSays?.(record['message']))
    ) {
      return true;
    }

    for (const key of ['cause', 'meta', 'driverAdapterError', 'originalError']) {
      if (key in record) stack.push(record[key]);
    }
  }

  return false;
}
