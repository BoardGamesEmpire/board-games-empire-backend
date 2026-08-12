import { PrismaError } from '@status/codes';
import { Prisma } from '../client';

/**
 * TEST FIXTURES. Nothing in production should construct a Prisma error.
 *
 * Reachable only through `@bge/database/testing`, never the main barrel. That this
 * lives in a production library at all is a known wart with a known fix — see #305.
 *
 * Co-located with {@link constraintIdentity} deliberately: the defect these prevent
 * (#298, #210, #251) was possible because the FABRICATION and the READER lived in
 * different libraries, so four specs each invented their own payload and no single
 * place could be checked against a real database. The e2e pin in
 * `apps/api-e2e/src/database/p2002-shape.spec.ts` is what keeps this file honest.
 */

interface DriverAdapterCause {
  readonly originalCode: string;
  readonly originalMessage: string;
  readonly kind: string;
  readonly constraint?: { readonly fields?: readonly string[]; readonly index?: string };
}

/**
 * A real Error subclass rather than an object literal, because the descriptors are
 * load-bearing for anything that logs the payload: `cause` is own and enumerable so
 * `JSON.stringify(meta)` captures the constraint, while `name` and `message` are
 * not and drop out.
 */
class DriverAdapterError extends Error {
  override readonly cause: DriverAdapterCause;

  constructor(cause: DriverAdapterCause) {
    super(cause.kind);
    this.cause = cause;
  }
}

// Assignment (`prototype.name = ...`) would create an ENUMERABLE property, and
// `for...in` walks inherited keys, so `name` would surface where a real Error's
// never does. Matches `Error.prototype.name`'s descriptor instead — fidelity is the
// entire point of a fixture.
Object.defineProperty(DriverAdapterError.prototype, 'name', {
  value: 'DriverAdapterError',
  writable: true,
  enumerable: false,
  configurable: true,
});

export interface UniqueViolationOptions {
  /**
   * Raw DB column names, as `@prisma/adapter-pg` reports them under
   * `cause.constraint.fields`. This is the shape that actually ships.
   */
  readonly fields?: readonly string[];

  /** MySQL-shaped index name under `cause.constraint.index`. Not this stack. */
  readonly index?: string;

  /**
   * Legacy `meta.target`. Absent on `@prisma/client@7.8.0` + `@prisma/adapter-pg`
   * (prisma/prisma#28953); supply it only to exercise the restored-`target` path.
   */
  readonly target?: string | readonly string[];

  /** Prisma's own `meta.modelName`. Nothing should read it — see #302. */
  readonly modelName?: string;

  /** Name quoted into `cause.originalMessage`, as Postgres phrases it. */
  readonly constraintName?: string;

  /** SQLSTATE. `23505` is unique_violation. */
  readonly sqlState?: string;

  /**
   * Omit `driverAdapterError` entirely, leaving `meta` with only `modelName`.
   * Models a Prisma release that stops exposing the adapter error.
   */
  readonly omitDriverAdapterError?: boolean;

  /**
   * Omit `meta` entirely. This is what a P2002 looked like to the four specs that
   * never fabricated one correctly, and it must map to each caller's documented
   * `unknown` fallback.
   */
  readonly omitMeta?: boolean;
}

/**
 * A P2002 in the shape `@prisma/client@7.8.0` + `@prisma/adapter-pg` on Postgres 17
 * actually raises, measured 2026-08-10 (#298).
 *
 * Defaults to a well-formed driver-adapter payload so a spec must opt IN to
 * degradation. The old helper defaulted to a fabricated `meta.target`, which is why
 * twelve green tests never touched reality.
 */
export function uniqueViolation(options: UniqueViolationOptions = {}): Prisma.PrismaClientKnownRequestError {
  const {
    fields,
    index,
    target,
    modelName = 'TestModel',
    constraintName = 'test_unique_constraint',
    sqlState = '23505',
    omitDriverAdapterError = false,
    omitMeta = false,
  } = options;

  const meta: Record<string, unknown> = { modelName };

  if (target !== undefined) {
    meta['target'] = target;
  }

  // A default `fields` is synthesized only when the caller names NO source at all.
  // Supplying `target` alone means target-ONLY: `constraintIdentity` prefers the
  // driver payload, so a synthesized default would shadow the field the caller
  // asked to exercise and the case would quietly assert something else.
  const explicitConstraint = fields !== undefined ? { fields } : index !== undefined ? { index } : undefined;
  const constraint = explicitConstraint ?? (target === undefined ? { fields: ['test_column'] } : undefined);

  if (!omitDriverAdapterError && constraint !== undefined) {
    meta['driverAdapterError'] = new DriverAdapterError({
      originalCode: sqlState,
      originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
      kind: 'UniqueConstraintViolation',
      constraint,
    });
  }

  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: PrismaError.UniqueConstraintViolation,
    clientVersion: 'test',
    ...(omitMeta ? {} : { meta }),
  });
}

/**
 * A P2002 with no `meta` at all — the shape every pre-#298 spec fabricated by
 * omission, and the one the row-lookup recovery paths (#210, #251) must replay on.
 */
export function uniqueViolationWithoutMeta(): Prisma.PrismaClientKnownRequestError {
  return uniqueViolation({ omitMeta: true });
}
