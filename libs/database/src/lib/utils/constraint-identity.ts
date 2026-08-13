import { isPrismaUniqueConstraintError } from './prisma-errors';

/**
 * Sources, in the order they are tried. Grouped by provenance: both driver-adapter
 * sources rank above Prisma's own.
 *
 * `driverAdapterError.fields` is parsed from Postgres's `DETAIL` line, so it names
 * the constraint that actually fired. `index` is the MySQL shape, mutually
 * exclusive with `fields` in practice; it sits above `target` because it comes from
 * the same place. `meta.target` is EMPTY under `@prisma/client@7.8.0` +
 * `@prisma/adapter-pg` (prisma/prisma#28953) and ranks last despite being the only
 * public one: if Prisma restores it, there is no reason to assume it arrives free
 * of the nested-create defect that makes `meta.modelName` unusable
 * (prisma/prisma#29595), so preferring it could let an upstream fix silently
 * reinstate the 500 this module removes. Accuracy outranks public-API status.
 */
export type IdentifiedConstraintSource = 'driverAdapterError.fields' | 'driverAdapterError.index' | 'meta.target';

/** A unique violation whose constraint we could name. */
export interface IdentifiedConstraint {
  readonly source: IdentifiedConstraintSource;
  /**
   * The names the payload reported, normalized and unquoted. Their SPELLING
   * varies by source — raw snake_case columns from `driverAdapterError.fields`,
   * Prisma field names from a restored `meta.target`, an index name from
   * `driverAdapterError.index` — so a caller must accept every spelling of the
   * constraint it cares about. {@link identifiesConstraint} is how.
   */
  readonly names: readonly string[];
  /** SQLSTATE from `cause.originalCode`, when the adapter reported one. */
  readonly sqlState?: string;
}

/**
 * A unique violation whose constraint could NOT be named.
 *
 * "I could not tell which constraint" is not "it was not that constraint".
 * Collapsing the two is what turned an unidentifiable error into a confidently
 * wrong answer in three separate services, so every caller must choose its own
 * fallback for this case and say so at the call site.
 */
export interface UnidentifiedConstraint {
  readonly source: 'unknown';
  readonly sqlState?: string;
}

/**
 * Not a unique violation at all. Kept separate from {@link UnidentifiedConstraint}
 * because a caller whose `unknown` fallback is "assume it was my constraint" would
 * otherwise translate a connection reset into that answer.
 */
export interface NotAUniqueViolation {
  readonly source: 'not-a-unique-violation';
}

export type ConstraintIdentity = IdentifiedConstraint | UnidentifiedConstraint | NotAUniqueViolation;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Both constructors OMIT `sqlState` rather than carrying an explicit `undefined`.
 * `toEqual` treats those as equal so it is invisible to most assertions, but
 * `toStrictEqual`, `Object.keys`, and `exactOptionalPropertyTypes` do not.
 */
function unidentified(sqlState: string | undefined): UnidentifiedConstraint {
  return sqlState === undefined ? { source: 'unknown' } : { source: 'unknown', sqlState };
}

function identified(
  source: IdentifiedConstraintSource,
  names: readonly string[],
  sqlState: string | undefined,
): IdentifiedConstraint {
  return sqlState === undefined ? { source, names } : { source, names, sqlState };
}

/**
 * Strips the quotes Postgres puts on identifiers that needed quoting, so a name
 * arriving as `"someField"` still compares equal to `someField`. Nothing measured
 * needs this — our columns are snake_case through Prisma's `@map`, so Postgres
 * never quotes them — but an un-`@map`ped camelCase field would be quoted in the
 * `DETAIL` string this shape is parsed from, and the comparison would fail
 * silently.
 *
 * Scanned rather than `/^"+|"+$/g`, which CodeQL flags as polynomial (alert 1).
 * The alert is right about the pattern and it did not reproduce in V8; this is
 * linear by construction rather than by engine optimization.
 */
function unquote(name: string): string {
  let start = 0;
  let end = name.length;

  while (start < end && name[start] === '"') {
    start += 1;
  }

  while (end > start && name[end - 1] === '"') {
    end -= 1;
  }

  return name.slice(start, end);
}

function normalizeNames(value: unknown): readonly string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];

  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map(unquote)
    .filter((entry) => entry.length > 0);
}

/**
 * Reads the driver adapter's `cause`, which is where the identity lives on this
 * stack. `driverAdapterError` is an `Error` INSTANCE whose `cause` is a plain
 * object; `name` and `cause` are own and enumerable (the real class declares
 * `name` as a class field, shadowing `Error.prototype.name`), while
 * `message`/`stack` are not.
 *
 * Enumerability is irrelevant to this function — it is property access throughout
 * — but it decides what `JSON.stringify(meta)` captures for the callers that log
 * the payload, so `prisma-error.fixtures.ts` pins it.
 */
function driverAdapterCause(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  const driverAdapterError = meta['driverAdapterError'];
  const cause = isRecord(driverAdapterError) ? driverAdapterError['cause'] : undefined;

  return isRecord(cause) ? cause : undefined;
}

/**
 * Normalizes a P2002 to the identity of the constraint that fired.
 *
 * READS NON-PUBLIC API, AND NEVER FOR CORRECTNESS. Prisma does not consider the
 * shape of `meta` public, `driverAdapterError` least of all. That is tolerable only
 * because a caller must treat `unknown` as "could not tell" and supply its own
 * answer, so a shape change degrades PRECISION and never correctness. A caller that
 * lets this decide something it cannot recover from is misusing it.
 *
 * Shape measured against `@prisma/client@7.8.0` + `@prisma/adapter-pg` on Postgres
 * 17 (2026-08-10, #298), and pinned in
 * `apps/api-e2e/src/database/p2002-shape.spec.ts` so a change is loud:
 *
 * ```
 * meta: {
 *   modelName: string,
 *   driverAdapterError: DriverAdapterError {
 *     cause: {
 *       originalCode:    '23505',
 *       originalMessage: 'duplicate key value violates unique constraint "<name>"',
 *       kind:            'UniqueConstraintViolation',
 *       constraint:      { fields: [ ...raw column names ] },
 *     },
 *   },
 * }
 * ```
 *
 * `meta.modelName` is deliberately never read — see #302. `cause.originalMessage`
 * carries the constraint name verbatim, but parsing a message is strictly more
 * fragile than reading a field.
 */
export function constraintIdentity(error: unknown): ConstraintIdentity {
  if (!isPrismaUniqueConstraintError(error)) {
    return { source: 'not-a-unique-violation' };
  }

  const meta = error.meta;
  if (!isRecord(meta)) {
    return unidentified(undefined);
  }

  const cause = driverAdapterCause(meta);
  const originalCode = cause?.['originalCode'];
  const sqlState = typeof originalCode === 'string' ? originalCode : undefined;

  const constraint = cause === undefined ? undefined : cause['constraint'];
  if (isRecord(constraint)) {
    const fields = normalizeNames(constraint['fields']);
    if (fields.length > 0) {
      return identified('driverAdapterError.fields', fields, sqlState);
    }

    const index = normalizeNames(constraint['index']);
    if (index.length > 0) {
      return identified('driverAdapterError.index', index, sqlState);
    }
  }

  const target = normalizeNames(meta['target']);
  if (target.length > 0) {
    return identified('meta.target', target, sqlState);
  }

  return unidentified(sqlState);
}

/** Narrows to the branch that carries names. */
export function isIdentifiedConstraint(identity: ConstraintIdentity): identity is IdentifiedConstraint {
  return identity.source !== 'unknown' && identity.source !== 'not-a-unique-violation';
}

/**
 * True when `identity` names EXACTLY one of the given spellings of a single
 * constraint, compared as an unordered set.
 *
 * SEVERAL SPELLINGS because the same constraint is reported differently per source:
 * raw columns from the driver adapter, Prisma field names from a restored
 * `meta.target`, an index name from MySQL. Accepting only the measured spelling
 * would silently stop matching the day Prisma restores `target`.
 *
 * EXACT rather than membership, so a superset cannot match — a future
 * `@@unique([householdId, userId, x])` reports three names and is a different
 * constraint. UNORDERED because `fields` order follows the `@@unique([...])`
 * declaration, and reordering that is semantically free to Postgres; an
 * order-sensitive check would let a harmless schema edit change a status code.
 */
export function identifiesConstraint(
  identity: ConstraintIdentity,
  ...spellings: readonly (readonly string[])[]
): boolean {
  if (!isIdentifiedConstraint(identity)) {
    return false;
  }

  const actual = new Set(identity.names);

  // A duplicate entry in `names` would otherwise let a shorter set pass the
  // length check — `['a','a']` is not `['a','b']`.
  if (actual.size !== identity.names.length) {
    return false;
  }

  return spellings.some((spelling) => spelling.length === actual.size && spelling.every((name) => actual.has(name)));
}
