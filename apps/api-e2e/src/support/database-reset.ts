import type { PrismaClient } from '@bge/database';

/** One row of `pg_tables`, as returned by {@link listUserTables}. */
export interface TableRef {
  readonly schemaname: string;
  readonly tablename: string;
}

/**
 * Tables the between-test sweep must NOT touch and must find populated:
 * Prisma's migration ledger plus every table populated by the
 * reference/catalog seeds (`libs/database/src/lib/seeds/run-seeds.ts`).
 * Everything else, bar {@link PRESERVED_MAY_BE_EMPTY_TABLE_NAMES}, is
 * truncated.
 *
 * Keep this list in lockstep with the seed set — a table seeded once per
 * run but truncated per test would fail every spec after the first.
 */
export const PRESERVED_TABLE_NAMES: readonly string[] = [
  '_prisma_migrations',
  'game_lengths',
  'languages',
  'language_tags',
  'permissions',
  'platforms',
  'roles',
  'role_permissions',
  'safe_http_policy',
  'system_settings',
];

/**
 * Tables the sweep leaves alone without requiring a row in them: the
 * data-migration ledger (#236). `data_migrations` is to the data what
 * `_prisma_migrations` is to the schema, and the bootstrap e2e specs run the
 * boot sequence against the harness database: were the ledger truncated
 * between tests, every such boot would apply the shipped registry's entries
 * again, over data they already shaped. The registry may be empty, so the
 * table may be too, and {@link assertPreservedTablesIntact} does not check
 * it. A spec that writes a ledger row removes it, as one does in
 * `_prisma_migrations`.
 */
export const PRESERVED_MAY_BE_EMPTY_TABLE_NAMES: readonly string[] = ['data_migrations'];

const PRESERVED = new Set([...PRESERVED_TABLE_NAMES, ...PRESERVED_MAY_BE_EMPTY_TABLE_NAMES]);
const MUST_BE_POPULATED = new Set(PRESERVED_TABLE_NAMES);

/**
 * `TRUNCATE` targets can't be bound as parameters, so identifiers are
 * interpolated — this gate keeps `$executeRawUnsafe` honest. Every name
 * Prisma generates for this schema matches; anything else is refused
 * loudly rather than quoted cleverly.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteQualifiedTable(ref: TableRef): string {
  for (const part of [ref.schemaname, ref.tablename]) {
    if (!SAFE_IDENTIFIER.test(part)) {
      throw new Error(`Refusing to interpolate unsafe identifier '${part}' into TRUNCATE`);
    }
  }

  return `"${ref.schemaname}"."${ref.tablename}"`;
}

/** Pure partition step, separated for unit testing. */
export function tablesToTruncate(all: readonly TableRef[], preserved: ReadonlySet<string> = PRESERVED): TableRef[] {
  return all.filter((table) => !preserved.has(table.tablename));
}

/** Pure filter for {@link assertPreservedTablesIntact}: the preserved tables that must hold a row after the sweep. */
export function tablesToAssertPopulated(
  all: readonly TableRef[],
  populated: ReadonlySet<string> = MUST_BE_POPULATED,
): TableRef[] {
  return all.filter((table) => populated.has(table.tablename));
}

/**
 * Pure staleness check, separated for unit testing: preserved names that do
 * not exist in the schema. Both preserved lists protect tables by name, so a
 * rename in the schema silently strands the old name here while the REAL
 * table — no longer matched — gets truncated. Detecting the stranded name is
 * the only signal that a list has drifted.
 */
export function missingPreservedTables(
  all: readonly TableRef[],
  preserved: readonly string[] = [...PRESERVED_TABLE_NAMES, ...PRESERVED_MAY_BE_EMPTY_TABLE_NAMES],
): string[] {
  const existing = new Set(all.map((table) => table.tablename));
  return preserved.filter((name) => !existing.has(name));
}

async function listUserTables(db: PrismaClient, schema: string): Promise<TableRef[]> {
  // Scoped to the schema the harness's DATABASE_URL targets: the
  // escape-hatch database may host other schemas (a dev `public` next to a
  // `?schema=e2e`), and truncating those is exactly the kind of collateral
  // the DISPOSABLE contract does not license.
  return db.$queryRaw<TableRef[]>`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = ${schema}
    ORDER BY schemaname, tablename`;
}

/**
 * The between-test isolation sweep (#255): truncates every user table
 * except {@link PRESERVED_TABLE_NAMES} and
 * {@link PRESERVED_MAY_BE_EMPTY_TABLE_NAMES} in a single
 * `TRUNCATE ... RESTART IDENTITY CASCADE` statement, then verifies the
 * seeded tables and the schema ledger are still populated.
 *
 * The verification exists because `CASCADE` follows foreign keys: today no
 * preserved table references a mutable one (verified against the schema at
 * #255 time), but the moment someone adds, say, an `updated_by` column to
 * `system_settings`, the sweep would silently empty it. Failing loudly with
 * the table name turns that schema change into an actionable error instead
 * of a cascade of baffling downstream failures.
 *
 * Discovery is `pg_tables`-driven (scoped to the supplied schema) so new
 * models are swept automatically without touching this file; a preserved
 * name that no longer exists in the schema aborts the sweep loudly, since
 * a stale entry means the real (renamed) table is being truncated.
 */
export async function resetDatabase(db: PrismaClient, schema: string): Promise<void> {
  const all = await listUserTables(db, schema);

  const missing = missingPreservedTables(all);
  if (missing.length > 0) {
    throw new Error(
      `The preserved-table lists name table(s) that do not exist in schema '${schema}': ${missing.join(', ')}. ` +
        `A list has drifted from the schema (rename? moved seed?) — refusing to sweep, because the renamed ` +
        `table would be truncated while this guard reported success (see PRESERVED_TABLE_NAMES and ` +
        `PRESERVED_MAY_BE_EMPTY_TABLE_NAMES).`,
    );
  }

  const targets = tablesToTruncate(all);

  if (targets.length > 0) {
    await db.$executeRawUnsafe(
      `TRUNCATE TABLE ${targets.map(quoteQualifiedTable).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }

  await assertPreservedTablesIntact(db, all);
}

export async function assertPreservedTablesIntact(db: PrismaClient, all: readonly TableRef[]): Promise<void> {
  const empty: string[] = [];

  for (const table of tablesToAssertPopulated(all)) {
    const rows = await db.$queryRawUnsafe<Array<{ populated: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM ${quoteQualifiedTable(table)}) AS populated`,
    );

    if (!rows[0]?.populated) {
      empty.push(table.tablename);
    }
  }

  if (empty.length > 0) {
    throw new Error(
      `resetDatabase left preserved table(s) empty: ${empty.join(', ')}. ` +
        `A foreign key from a preserved table to a truncated one lets TRUNCATE ... CASCADE sweep it — ` +
        `check recent schema changes and update the sweep (see PRESERVED_TABLE_NAMES, #255).`,
    );
  }
}
