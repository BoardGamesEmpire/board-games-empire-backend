import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const OK_PATH = '/api/auth/ok';

/**
 * Whether the schema holds what better-auth 1.7 expects of it (#1016). From
 * 1.7 on, better-auth checks that the models its plugins use have every column
 * they need, and while they don't, it answers every request under `/api/auth`
 * with an error. It reads that from the Prisma client's models and opens no
 * connection, so it never sees the database itself: a migration left out of a
 * model change, or a unique index the plugin expects, goes unflagged. The first
 * test is the check, over the running api; the others read the migrated database.
 */
describe("the schema better-auth's boot check reads", () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  const columnsOf = async (table: string): Promise<string[]> => {
    // Bound to `db.schema`, not `current_schema()`: raw SQL runs against the
    // connection default, which is not the schema under the `?schema=` escape
    // hatch.
    const rows = await db.client.$queryRaw<{ column: string }[]>`
      SELECT column_name::text AS "column"
      FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ${table}
    `;

    return rows.map((row) => row.column);
  };

  const indexDefinitionsOf = async (table: string): Promise<string[]> => {
    const rows = await db.client.$queryRaw<{ definition: string }[]>`
      SELECT indexdef::text AS definition
      FROM pg_indexes
      WHERE schemaname = ${db.schema} AND tablename = ${table}
    `;

    return rows.map((row) => row.definition);
  };

  it("answers /api/auth/ok, because the schema passes better-auth's check at boot (#1016)", async () => {
    const response = await request(baseUrl).get(OK_PATH);

    expect(response.status).toBe(200);
  });

  it('gives two_factor the columns that lock a user out after failed verifications (#1016)', async () => {
    // The two-factor plugin's schema, which 1.7 widened. The Prisma models
    // carry the columns, so only the migrated database shows one missing.
    const columns = await columnsOf('two_factor');

    expect(columns).toEqual(expect.arrayContaining(['failed_verification_count', 'locked_until']));
  });

  it.each(['device_code', 'user_code'])(
    'keeps device_codes unique on %s, so one code never names two device authorizations (#1016)',
    async (column) => {
      // The boot check doesn't flag a missing unique index, so the index is
      // asserted here. `CREATE UNIQUE INDEX ... (column)` also excludes the
      // primary key, whose column is `id`.
      const definitions = await indexDefinitionsOf('device_codes');

      expect(definitions).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`^CREATE UNIQUE INDEX .+ USING btree \\(${column}\\)$`)),
        ]),
      );
    },
  );
});
