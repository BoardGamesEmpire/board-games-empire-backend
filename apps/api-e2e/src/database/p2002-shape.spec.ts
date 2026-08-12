import {
  constraintIdentity,
  identifiesConstraint,
  isPrismaUniqueConstraintError,
  Prisma,
  SystemRole,
} from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import { inspect } from 'node:util';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * Pins the P2002 payload `constraintIdentity` reads, against a real database.
 *
 * ## Why this file exists at all
 *
 * `HouseholdMemberService.addMemberWithin` runs inside a transaction Postgres has
 * already aborted, and Prisma opens no savepoint — so unlike the household and
 * feedback replay paths it cannot re-read the row to decide whether a unique
 * violation means "already a member" (409) or something else (500). The error
 * payload is its only source of truth, and the field carrying that truth is
 * explicitly NOT public Prisma API.
 *
 * Depending on non-public API is tolerable there for one reason: an unreadable
 * payload degrades to a documented 409 fallback, so correctness never rests on
 * this shape — only precision does. This file is what makes a change to it LOUD
 * instead of silent. That is the property all three of the original defects
 * lacked (#210, #251, #298): every one of them was asserted correct by green unit
 * tests that fabricated the payload they were reading.
 *
 * These assertions are therefore CHARACTERIZATION. Going red here is not
 * necessarily a defect — a restored `meta.target` would be welcome — but it must
 * be a decision rather than a drift, so each failure message carries the observed
 * payload and says what to do with it.
 *
 * ## Plumbing
 *
 * Sanctioned under #255's revised D-6 ("verifying state no endpoint exposes"), and
 * representative because `createTestDatabase` builds its client the way
 * `DatabaseService` builds its own — explicit `pg` Pool plus `PrismaPg`. If either
 * side stops using the driver adapter, this observes a shape the application does
 * not.
 *
 * Constants are inlined rather than imported from `@bge/household`: that barrel
 * re-exports the controller and module, so importing one string would evaluate
 * Nest decorator metadata and pull `@bge/permissions`, `@bge/i18n`, and rxjs into
 * the test process. The values are what POSTGRES reports, a database fact rather
 * than an application constant, and a mismatch fails here with both values printed.
 */

/** DB name of `@@unique([householdId, userId])`, as mapped in the schema. */
const HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT = 'household_member_household_user_unique';

/** Raw column pair the pg adapter reports for that constraint. */
const HOUSEHOLD_MEMBER_UNIQUE_COLUMNS = ['household_id', 'user_id'] as const;

/** Prisma field-name spelling, which a restored `meta.target` would use. */
const HOUSEHOLD_MEMBER_UNIQUE_FIELDS = ['householdId', 'userId'] as const;

/** SQLSTATE unique_violation. */
const SQLSTATE_UNIQUE_VIOLATION = '23505';

/** Renders a payload for a failure message, including what JSON.stringify drops. */
const describePayload = (error: unknown): string => inspect(error, { depth: null, showHidden: true, getters: true });

async function captureUniqueViolation(
  operation: () => Promise<unknown>,
  what: string,
): Promise<Prisma.PrismaClientKnownRequestError> {
  let caught: unknown;

  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(
      `Expected a unique violation from ${what}, but nothing threw. The constraint under test is missing from ` +
        `the applied migration set, or the arrangement no longer produces a duplicate.`,
    );
  }

  if (!isPrismaUniqueConstraintError(caught)) {
    throw new Error(
      `Expected a P2002 from ${what}, got: ${describePayload(caught)}. Every discriminator downstream gates on ` +
        `isPrismaUniqueConstraintError first, so a different error class means they all stop working.`,
    );
  }

  return caught;
}

describe('P2002 payload shape (#298 characterization)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * A committed household with its founder membership, plus a spare user.
   *
   * Built through the real fixtures rather than hand-rolled inserts: `User` is a
   * BetterAuth table with its own required columns, and reproducing them here
   * would be a second source of truth that can rot. `origin` / `addedById` are
   * left unset — both are nullable, and provenance has no bearing on which index
   * a duplicate trips.
   *
   * Re-arranged per test rather than once, because the isolation sweep truncates
   * between tests (#255).
   */
  const arrange = async () => {
    const owner = await actors.user();
    const spare = await actors.user();
    const fixture = await actors.householdWithMembers({ owner, name: 'P2002 probe household' });

    return {
      householdId: fixture.household.id,
      ownerUserId: owner.user.id,
      ownerMemberId: fixture.owner.member.id,
      spareUserId: spare.user.id,
    };
  };

  describe('the membership unique', () => {
    // The real `addMemberWithin` call site: nested member+role create, inside an
    // interactive transaction, duplicating a membership that is already committed.
    it('identifies itself by raw column pair from a NESTED create inside a transaction', async () => {
      const { householdId, ownerUserId } = await arrange();

      const error = await captureUniqueViolation(
        () =>
          db.client.$transaction((tx) =>
            tx.householdMember.create({
              data: {
                householdId,
                userId: ownerUserId,
                role: { create: { role: { connect: { name: SystemRole.HouseholdMember } } } },
              },
            }),
          ),
        'a nested member+role create duplicating (householdId, userId) inside a transaction',
      );

      const identity = constraintIdentity(error);

      // The prerequisite for ANY payload-reading design, and the one that could
      // not be assumed: a constraint violation inside an interactive transaction
      // still arrives as a PrismaClientKnownRequestError with `meta` intact,
      // rather than as a "current transaction is aborted" error from the driver.
      expect(identity).toEqual({
        source: 'driverAdapterError.fields',
        names: [...HOUSEHOLD_MEMBER_UNIQUE_COLUMNS],
        sqlState: SQLSTATE_UNIQUE_VIOLATION,
      });

      expect(
        identifiesConstraint(identity, HOUSEHOLD_MEMBER_UNIQUE_COLUMNS, HOUSEHOLD_MEMBER_UNIQUE_FIELDS, [
          HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT,
        ]),
      ).toBe(true);
    });

    // Isolates whether nesting or the transaction changes the payload. Measured
    // 2026-08-10: they do not, which is what retired the doubt about extrapolating
    // the households measurement onto this table.
    it('reports the same identity from a FLAT create with no transaction', async () => {
      const { householdId, ownerUserId } = await arrange();

      const error = await captureUniqueViolation(
        () => db.client.householdMember.create({ data: { householdId, userId: ownerUserId } }),
        'a flat member create duplicating (householdId, userId)',
      );

      expect(constraintIdentity(error)).toEqual({
        source: 'driverAdapterError.fields',
        names: [...HOUSEHOLD_MEMBER_UNIQUE_COLUMNS],
        sqlState: SQLSTATE_UNIQUE_VIOLATION,
      });
    });

    // `meta.target` is empty on this stack (prisma/prisma#28953). Asserted
    // separately from the identity above because the two failures mean opposite
    // things: the identity going red is a problem, `target` appearing is not.
    it('does NOT populate meta.target', async () => {
      const { householdId, ownerUserId } = await arrange();

      const error = await captureUniqueViolation(
        () => db.client.householdMember.create({ data: { householdId, userId: ownerUserId } }),
        'a flat member create duplicating (householdId, userId)',
      );

      const target = error.meta?.['target'];

      if (target !== undefined) {
        throw new Error(
          `Prisma now populates meta.target (${JSON.stringify(target)}). That is a CHANGE, not a defect, and the ` +
            `fix keeps working: constraintIdentity reads it as a FALLBACK behind the driver payload and accepts ` +
            `the Prisma field-name spelling. Do NOT promote it above driverAdapterError.cause.constraint.fields ` +
            `on the grounds that it is public API — the driver payload is parsed from Postgres's own DETAIL line ` +
            `and cannot name the wrong table, whereas a restored target may carry the nested-create defect that ` +
            `already makes meta.modelName unusable (prisma/prisma#29595, #302). Confirm the spelling matches ` +
            `HOUSEHOLD_MEMBER_UNIQUE_FIELDS, then update this assertion and the notes on #298 / #292 ` +
            `deliberately. Observed payload: ${describePayload(error.meta)}`,
        );
      }

      expect(target).toBeUndefined();
    });
  });

  // The comparator for "identified, but not the membership constraint → rethrow".
  // Without a measured primary-key payload that branch could not be written.
  it('identifies a primary-key collision as its own single-column constraint', async () => {
    const { householdId, ownerMemberId, spareUserId } = await arrange();

    // A DIFFERENT userId, so the composite unique cannot fire first and steal the
    // violation — only the primary key can.
    const error = await captureUniqueViolation(
      () => db.client.householdMember.create({ data: { id: ownerMemberId, householdId, userId: spareUserId } }),
      'a member create reusing an existing primary key',
    );

    const identity = constraintIdentity(error);

    expect(identity).toEqual({
      source: 'driverAdapterError.fields',
      names: ['id'],
      sqlState: SQLSTATE_UNIQUE_VIOLATION,
    });

    expect(identifiesConstraint(identity, HOUSEHOLD_MEMBER_UNIQUE_COLUMNS, HOUSEHOLD_MEMBER_UNIQUE_FIELDS)).toBe(false);
  });

  /**
   * The guard that keeps `addMemberWithin`'s `unknown` fallback honest.
   *
   * That fallback answers 409 for an unidentifiable P2002, and it is sound only
   * because the membership unique is the ONLY violation the insert can reach:
   * `household_members` carries one uniqueness rule besides its primary key,
   * `household_roles`' rules key on a `householdMemberId` the statement generates
   * fresh, and a cuid2 primary-key collision is negligible.
   *
   * Adding a second unique to `household_members` invalidates that enumeration
   * rather than merely widening it, so this must fail rather than be updated
   * reflexively.
   *
   * ## Why `pg_index` and not `pg_constraint`
   *
   * Because the first version of this guard asked `pg_constraint` and got an empty
   * list while the constraint plainly worked — the three cases above had already
   * read `['household_id', 'user_id']` off a live violation.
   *
   * Prisma's migration engine emits `CREATE UNIQUE INDEX` for `@@unique`, not
   * `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE`. In Postgres those are different
   * objects: the former is a `pg_index` row with `indisunique` and NO
   * `pg_constraint` row at all. `pg_constraint` carries only uniqueness that was
   * declared AS a constraint, so on a Prisma-migrated schema it sees the primary
   * key and nothing else.
   *
   * `pg_index` is also the strictly better catalog for this guard's purpose. A
   * unique constraint is backed by a unique index too, so asking `pg_index`
   * catches every uniqueness rule however it was declared — which is what the
   * fallback's reasoning actually depends on. Non-unique indexes such as
   * `@@index([userId])` are excluded by `indisunique`, and the primary key is
   * separated by `indisprimary` rather than dropped, so both halves of the
   * enumeration are asserted.
   *
   * Worth noting for anyone reading a raw payload: Postgres words the violation as
   * `duplicate key value violates unique constraint "<name>"` even when the object
   * is a plain unique index. That phrasing is why the mapped name reads like a
   * constraint name, and why MySQL's `constraint.index` and this name are the same
   * kind of thing.
   */
  it('holds household_members to exactly one uniqueness rule besides its primary key', async () => {
    const relation = `${db.schema}.household_members`;

    // Checked FIRST because the query below cannot tell the two apart: an
    // unresolved `to_regclass` is NULL, `indrelid = NULL` matches nothing, and the
    // result is an empty list either way. Without this, a schema-resolution
    // problem reports as a schema change and sends the next reader after entirely
    // the wrong thing — which is how the first version of this test read.
    const [resolution] = await db.client.$queryRaw<{ found: boolean }[]>`
      SELECT to_regclass(${relation}) IS NOT NULL AS found
    `;

    if (resolution?.found !== true) {
      throw new Error(
        `Could not resolve '${relation}' in the test database, so this assertion cannot say anything about its ` +
          `uniqueness rules. Check that migrations ran against this schema before reading the count below as a ` +
          `schema change.`,
      );
    }

    const indexes = await db.client.$queryRaw<{ name: string; isPrimary: boolean }[]>`
      SELECT i.relname::text AS name, ix.indisprimary AS "isPrimary"
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE ix.indrelid = to_regclass(${relation})
        AND ix.indisunique
      ORDER BY i.relname
    `;

    const uniques = indexes.filter((row) => !row.isPrimary).map((row) => row.name);
    const primaryKeys = indexes.filter((row) => row.isPrimary).map((row) => row.name);

    if (uniques.length !== 1 || uniques[0] !== HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT) {
      throw new Error(
        `household_members must carry exactly one uniqueness rule besides its primary key, ` +
          `'${HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT}', and it now carries ${JSON.stringify(uniques)}. ` +
          `addMemberWithin answers 409 for an UNIDENTIFIABLE P2002 on the strength of that being the only ` +
          `reachable violation (#298). A second unique breaks the reasoning, not just the count — revisit the ` +
          `fallback before updating this assertion.`,
      );
    }

    expect(uniques).toEqual([HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT]);
    expect(primaryKeys).toHaveLength(1);
  });

  /**
   * The OTHER half of the fallback's reasoning, which the guard above does not
   * reach.
   *
   * `addMemberWithin` answers 409 for an unidentifiable P2002 on a three-legged
   * argument: `household_members` carries one uniqueness rule besides its primary
   * key (guarded above), `household_roles`' rules all key on a
   * `householdMemberId` the statement generates fresh so none of them can collide,
   * and a cuid2 primary-key collision is negligible. Only the first leg was
   * guarded, so a new unique on `household_roles` could break the reasoning with
   * nothing going red — the nested role create is part of the same statement, and
   * a rule not keyed on the fresh member id could genuinely fire.
   *
   * Asserted as a PROPERTY rather than as a list of index names: every unique rule
   * on `household_roles` must include `household_member_id` among its columns.
   * That is the thing the argument actually depends on, and it stays true through
   * #303's cleanup (which removes a redundant rule) while still failing for a rule
   * keyed on anything else.
   *
   * The third leg is not testable and is not asserted. A cuid2 collision is a
   * probability claim, not a schema fact.
   */
  it('holds every household_roles unique rule to a column the insert generates fresh', async () => {
    const relation = `${db.schema}.household_roles`;
    const generatedColumn = 'household_member_id';

    const [resolution] = await db.client.$queryRaw<{ found: boolean }[]>`
      SELECT to_regclass(${relation}) IS NOT NULL AS found
    `;

    if (resolution?.found !== true) {
      throw new Error(
        `Could not resolve '${relation}' in the test database, so this assertion cannot say anything about its ` +
          `uniqueness rules. Check that migrations ran against this schema.`,
      );
    }

    // One row per (index, column). `indkey` is the ordered column list, so
    // `attnum = ANY(indkey)` expands a composite rule into its members.
    const columns = await db.client.$queryRaw<{ index: string; column: string }[]>`
      SELECT i.relname::text AS index, a.attname::text AS column
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY (ix.indkey)
      WHERE ix.indrelid = to_regclass(${relation})
        AND ix.indisunique
        AND NOT ix.indisprimary
      ORDER BY i.relname, a.attname
    `;

    const byIndex = new Map<string, string[]>();
    for (const row of columns) {
      byIndex.set(row.index, [...(byIndex.get(row.index) ?? []), row.column]);
    }

    if (byIndex.size === 0) {
      throw new Error(
        `Expected at least one unique rule on '${relation}', found none. Either the schema changed or this query ` +
          `is wrong — an empty result must not be read as "nothing can collide".`,
      );
    }

    const unkeyed = [...byIndex.entries()]
      .filter(([, cols]) => !cols.includes(generatedColumn))
      .map(([index, cols]) => `${index}(${cols.join(', ')})`);

    if (unkeyed.length > 0) {
      throw new Error(
        `Every unique rule on household_roles must include '${generatedColumn}', because addMemberWithin answers ` +
          `409 for an UNIDENTIFIABLE P2002 on the strength of no role-table rule being able to collide — the ` +
          `member id is generated fresh by the same statement (#298). These do not: ${unkeyed.join('; ')}. ` +
          `A rule keyed on anything else CAN fire, so revisit the fallback before updating this assertion.`,
      );
    }

    expect(unkeyed).toEqual([]);
  });
});
