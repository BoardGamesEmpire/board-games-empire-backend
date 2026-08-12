import { Prisma } from '../client';
import {
  constraintIdentity,
  identifiesConstraint,
  isIdentifiedConstraint,
  type ConstraintIdentity,
} from './constraint-identity';
import { uniqueViolation, uniqueViolationWithoutMeta } from './prisma-error.fixtures';

/**
 * The branch coverage the e2e pin cannot reach.
 *
 * `apps/api-e2e/src/database/p2002-shape.spec.ts` proves that a real database
 * produces the shape {@link uniqueViolation} fabricates. This file proves what
 * the normalizer does with that shape and with every degradation of it. Neither
 * substitutes for the other, and the reason to say so is that the defect this
 * module replaces shipped behind twelve green unit tests: all of them fabricated
 * a `meta.target`, and nothing compared that fabrication against a live P2002.
 */
describe('constraintIdentity', () => {
  const MEMBER_COLUMNS = ['household_id', 'user_id'] as const;
  const MEMBER_FIELDS = ['householdId', 'userId'] as const;

  describe('the shape that ships', () => {
    // MEASURED 2026-08-10 against @prisma/client@7.8.0 + @prisma/adapter-pg on
    // Postgres 17 (#298). Raw snake_case columns, under the driver adapter.
    it('reads raw column names from driverAdapterError.cause.constraint.fields', () => {
      const identity = constraintIdentity(uniqueViolation({ fields: MEMBER_COLUMNS }));

      expect(identity).toEqual({
        source: 'driverAdapterError.fields',
        names: ['household_id', 'user_id'],
        sqlState: '23505',
      });
    });

    it('carries the SQLSTATE, which is independent of the Prisma mapping layer', () => {
      const identity = constraintIdentity(uniqueViolation({ fields: ['id'], sqlState: '23505' }));

      expect(identity).toMatchObject({ sqlState: '23505' });
    });

    // The comparator for "identified, but not the constraint I care about".
    // Without a measured primary-key payload that branch was unwritable.
    it('identifies a primary-key violation as its own single-column constraint', () => {
      const identity = constraintIdentity(uniqueViolation({ fields: ['id'] }));

      expect(identity).toMatchObject({ source: 'driverAdapterError.fields', names: ['id'] });
      expect(identifiesConstraint(identity, MEMBER_COLUMNS, MEMBER_FIELDS)).toBe(false);
    });
  });

  describe('source precedence', () => {
    // The driver payload wins because it is the most ACCURATE source, not the
    // most stable one. `constraint.fields` is parsed from Postgres's own DETAIL
    // line, so it names the constraint that actually fired; `meta.target` is
    // Prisma's mapping layer on top of that, and there is no reason to assume a
    // restored `target` arrives free of the nested-create defect that already
    // makes `meta.modelName` unusable (prisma/prisma#29595).
    //
    // Asserted rather than left implicit because getting this backwards is
    // SILENT: preferring `target` would mean the day Prisma fixes its own bug,
    // a wrong value gets chosen over a correct one and the 500 this module
    // removes comes back with every unit test still green.
    it('prefers the driver adapter over meta.target when BOTH are present', () => {
      const identity = constraintIdentity(uniqueViolation({ target: MEMBER_FIELDS, fields: MEMBER_COLUMNS }));

      expect(identity).toMatchObject({ source: 'driverAdapterError.fields', names: ['household_id', 'user_id'] });
    });

    // Preferring the driver payload must not mean IGNORING target. If a future
    // Prisma restores it while the non-public field goes away, this is the only
    // thing standing between a real conflict and the unknown fallback.
    it('falls back to meta.target when the driver adapter reports no constraint', () => {
      const identity = constraintIdentity(uniqueViolation({ target: MEMBER_FIELDS, omitDriverAdapterError: true }));

      expect(identity).toMatchObject({ source: 'meta.target', names: ['householdId', 'userId'] });
    });

    it('accepts a bare-string meta.target as a single name', () => {
      const identity = constraintIdentity(
        uniqueViolation({ target: 'household_member_household_user_unique', omitDriverAdapterError: true }),
      );

      expect(identity).toMatchObject({
        source: 'meta.target',
        names: ['household_member_household_user_unique'],
      });
    });

    it('falls through to the MySQL index shape when no fields are reported', () => {
      const identity = constraintIdentity(uniqueViolation({ index: 'household_member_household_user_unique' }));

      expect(identity).toMatchObject({
        source: 'driverAdapterError.index',
        names: ['household_member_household_user_unique'],
      });
    });

    it('discards non-string entries rather than admitting them as names', () => {
      const error = uniqueViolation({ omitDriverAdapterError: true });
      const meta = error.meta;

      if (meta === undefined) {
        throw new Error('Fixture regression: uniqueViolation should populate meta unless omitMeta is set.');
      }

      // A shape no adapter is known to produce. The point is that a malformed
      // array degrades to the surviving strings here, rather than to a type error
      // at a comparison site further away. Assigned directly rather than through
      // the factory because the factory's `target` is correctly typed and should
      // not be widened to admit this.
      meta['target'] = ['user_id', 7, null, undefined];

      expect(constraintIdentity(error)).toMatchObject({ names: ['user_id'] });
    });
  });

  describe('quoting', () => {
    // Nothing measured needed this: our columns are snake_case through Prisma's
    // `@map`, so Postgres never quotes them. An un-`@map`ped camelCase field
    // would be quoted in the DETAIL string this shape is parsed from, and a naive
    // comparison against the unquoted name fails SILENTLY — the same class of
    // near-miss as the original defect.
    it('strips the quotes Postgres puts on identifiers that needed them', () => {
      const identity = constraintIdentity(uniqueViolation({ fields: ['"createdById"', '"clientRequestId"'] }));

      expect(identity).toMatchObject({ names: ['createdById', 'clientRequestId'] });
    });

    it('matches a quoted payload against the unquoted spelling', () => {
      const identity = constraintIdentity(uniqueViolation({ fields: ['"householdId"', '"userId"'] }));

      expect(identifiesConstraint(identity, MEMBER_FIELDS)).toBe(true);
    });
  });

  describe('degradation', () => {
    // Each of these must be `unknown` and NOT `not-a-unique-violation`: they are
    // real unique violations whose constraint could not be named, and the caller's
    // fallback depends on telling those two apart.
    it('reports unknown when meta is absent entirely', () => {
      expect(constraintIdentity(uniqueViolationWithoutMeta())).toEqual({ source: 'unknown' });
    });

    it('reports unknown when the driver adapter error is absent', () => {
      expect(constraintIdentity(uniqueViolation({ omitDriverAdapterError: true }))).toEqual({ source: 'unknown' });
    });

    // toStrictEqual, not toEqual, and that is the entire point: toEqual treats a
    // missing key and an explicit `undefined` as equal, so a result carrying
    // `sqlState: undefined` on some branches and omitting it on others is
    // invisible to every other assertion in this file. It is not invisible to
    // Object.keys, to toStrictEqual, or to exactOptionalPropertyTypes, which
    // rejects `{ sqlState: undefined }` against `sqlState?: string` outright.
    it.each([
      ['meta is absent', uniqueViolationWithoutMeta],
      ['the driver adapter error is absent', () => uniqueViolation({ omitDriverAdapterError: true })],
    ])('OMITS sqlState rather than setting it undefined when %s', (_label, build: () => Error) => {
      const identity = constraintIdentity(build());

      expect(identity).toStrictEqual({ source: 'unknown' });
      expect(Object.keys(identity)).toEqual(['source']);
    });

    it('carries sqlState as a real key when the adapter reported one', () => {
      expect(constraintIdentity(uniqueViolation({ fields: [] }))).toStrictEqual({
        source: 'unknown',
        sqlState: '23505',
      });
    });

    it('reports unknown, but still surfaces the SQLSTATE, when the constraint is unnamed', () => {
      const error = uniqueViolation({ fields: [] });

      expect(constraintIdentity(error)).toEqual({ source: 'unknown', sqlState: '23505' });
    });

    it('never lets an unknown identity satisfy a constraint check', () => {
      const identity = constraintIdentity(uniqueViolationWithoutMeta());

      expect(isIdentifiedConstraint(identity)).toBe(false);
      expect(identifiesConstraint(identity, MEMBER_COLUMNS, MEMBER_FIELDS)).toBe(false);
    });
  });

  describe('errors that are not unique violations', () => {
    // Kept distinct from `unknown` on purpose. A caller whose fallback for
    // `unknown` is "assume it was my constraint" would otherwise translate a
    // connection reset into that answer.
    it.each([
      ['a non-Prisma error', new Error('connection reset')],
      [
        'a Prisma error with a different code',
        new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 'test' }),
      ],
      ['a plain object', { code: 'P2002' }],
      ['null', null],
      ['undefined', undefined],
    ])('reports not-a-unique-violation for %s', (_label, error: unknown) => {
      expect(constraintIdentity(error)).toEqual({ source: 'not-a-unique-violation' });
    });
  });
});

/**
 * The fixture is only worth having while it matches the article. These pin the two
 * properties the reader and its logging actually depend on, both of which were
 * asserted correct once by an assertion that could not distinguish the right
 * mechanism from the wrong one.
 */
describe('uniqueViolation fixture fidelity', () => {
  const driverAdapterErrorOf = (error: Prisma.PrismaClientKnownRequestError): object => {
    const candidate = error.meta?.['driverAdapterError'];

    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error('Fixture regression: expected meta.driverAdapterError to be an object.');
    }

    return candidate;
  };

  // `name` must be non-enumerable ON THE PROTOTYPE, as Error.prototype.name is.
  // Plain assignment creates an enumerable prototype property, and `for...in`
  // walks inherited enumerable keys, so `name` would surface where a real Error's
  // never does. JSON.stringify skips inherited properties either way, which is
  // exactly why the serialization check below passed while the descriptor was
  // wrong.
  it('exposes only cause to for...in, as a real Error subclass does', () => {
    const driverAdapterError = driverAdapterErrorOf(uniqueViolation({ fields: ['household_id'] }));

    const enumerableKeys: string[] = [];
    for (const key in driverAdapterError) {
      enumerableKeys.push(key);
    }

    expect(enumerableKeys).toEqual(['cause']);
    expect(driverAdapterError).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(driverAdapterError), 'name')).toMatchObject({
      value: 'DriverAdapterError',
      enumerable: false,
    });
  });

  // Load-bearing for the rethrow log in HouseholdMemberService, which prints the
  // whole `meta`. If `cause` stopped being own-and-enumerable the log would go
  // back to being useless without anything else failing.
  it('keeps the constraint reachable through JSON.stringify(meta)', () => {
    const error = uniqueViolation({ fields: ['household_id', 'user_id'] });
    const serialized = JSON.stringify(error.meta);

    expect(serialized).toContain('household_id');
    expect(serialized).not.toContain('DriverAdapterError');
  });
});

describe('identifiesConstraint', () => {
  const identityFor = (fields: readonly string[]): ConstraintIdentity =>
    constraintIdentity(uniqueViolation({ fields }));

  it('matches an exact set regardless of order', () => {
    // `fields` order derives from Postgres's DETAIL line, which follows index
    // column order, which follows the `@@unique([...])` declaration. Reordering
    // that declaration is semantically free to Postgres, so an order-sensitive
    // comparison would let a harmless schema edit change a status code.
    expect(identifiesConstraint(identityFor(['user_id', 'household_id']), ['household_id', 'user_id'])).toBe(true);
  });

  // The reason to compare exactly rather than by membership. A membership check
  // would accept this as the two-column constraint and answer confidently about
  // the wrong index.
  it('rejects a SUPERSET of the expected names', () => {
    expect(
      identifiesConstraint(identityFor(['household_id', 'user_id', 'archived_at']), ['household_id', 'user_id']),
    ).toBe(false);
  });

  it('rejects a subset of the expected names', () => {
    expect(identifiesConstraint(identityFor(['user_id']), ['household_id', 'user_id'])).toBe(false);
  });

  it('rejects a duplicated name padding the length out to the expected size', () => {
    expect(identifiesConstraint(identityFor(['user_id', 'user_id']), ['household_id', 'user_id'])).toBe(false);
  });

  it('accepts any one of several spellings of the same constraint', () => {
    const columns = ['household_id', 'user_id'] as const;
    const fields = ['householdId', 'userId'] as const;
    const indexName = ['household_member_household_user_unique'] as const;

    expect(identifiesConstraint(identityFor(columns), columns, fields, indexName)).toBe(true);
    expect(identifiesConstraint(identityFor(fields), columns, fields, indexName)).toBe(true);
    expect(identifiesConstraint(identityFor(indexName), columns, fields, indexName)).toBe(true);
  });

  it('returns false when given no spellings at all', () => {
    expect(identifiesConstraint(identityFor(['household_id', 'user_id']))).toBe(false);
  });
});
