import type { Prisma, PrismaClient } from '../client';
import type { AppliedMigrationRow } from './migration-state';

/** Postgres `undefined_table`: the ledger does not exist yet. */
const UNDEFINED_TABLE = '42P01';
/** Prisma's raw-query failure embeds the SQLSTATE: "Raw query failed. Code: `42P01`. Message: `...`". */
const UNDEFINED_TABLE_IN_MESSAGE = `Code: \`${UNDEFINED_TABLE}\``;
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
 * The driver adapter surfaces the SQLSTATE in more than one position (see
 * `isDeadlockError` in `../utils` for the same problem with 40P01), so the
 * error graph is walked for it; the message is consulted only for the exact
 * Prisma and Postgres wordings of "that table is not there".
 */
function isUndefinedTable(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (record['code'] === UNDEFINED_TABLE || record['sqlState'] === UNDEFINED_TABLE) return true;
    if (
      typeof record['message'] === 'string' &&
      (record['message'].includes(UNDEFINED_TABLE_IN_MESSAGE) || LEDGER_MISSING.test(record['message']))
    ) {
      return true;
    }

    for (const key of ['cause', 'meta', 'driverAdapterError', 'originalError']) {
      if (key in record) stack.push(record[key]);
    }
  }

  return false;
}
