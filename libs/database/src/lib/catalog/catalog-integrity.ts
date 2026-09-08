import { ResourceType, SystemRole } from '../client';
import type { PermissionSeedDefinition, RoleSeedDefinition } from './seed-definitions';

/**
 * Structural integrity of the seeded catalogs, asserted where the catalogs
 * are DEFINED so a defect fails the first runtime import — a test, API boot,
 * or the seed's own import before it writes a row — rather than partway
 * through the seed run that happens to reach it. The typecheck does not
 * evaluate the module, so it cannot catch these. These were runtime throws
 * inside the seed's `assignPermissions` loop (#233 promoted them); the seed
 * keeps its own copies as defense, but nothing should reach them.
 *
 * Every function takes the catalog it checks as an argument rather than
 * importing the shipped one, so the negative cases can be exercised with
 * fixtures and the shipped catalog can be checked by the same code path.
 */

const VALID_SUBJECTS: ReadonlySet<string> = new Set<string>([...Object.values(ResourceType), 'all']);
const SYSTEM_ROLES: ReadonlySet<string> = new Set<string>(Object.values(SystemRole));

/** Every slug in the catalog appears exactly once. */
export function assertUniqueSlugs(catalog: readonly PermissionSeedDefinition[]): void {
  const seen = new Set<string>();
  for (const { slug } of catalog) {
    if (seen.has(slug)) {
      throw new Error(`Permission catalog defines slug '${slug}' more than once`);
    }

    seen.add(slug);
  }
}

/** Every subject is a `ResourceType` member or the literal `'all'`. */
export function assertValidSubjects(catalog: readonly PermissionSeedDefinition[]): void {
  for (const { slug, subject } of catalog) {
    if (!VALID_SUBJECTS.has(subject)) {
      throw new Error(`Permission '${slug}' has subject '${subject}', which is not a ResourceType member or 'all'`);
    }
  }
}

/**
 * Every `conditions` value is JSON as written: a string, a finite number, a
 * boolean, `null`, or an array or plain object of those, with no `undefined`
 * member and no hole. `permission()` types `conditions` as the subject's
 * `WhereInput`, which also admits a `Date`, a `bigint` or a `FieldRef` the
 * compiler cannot rule out, and casts the entry to the JSON object the seed
 * writes; this assertion is what makes that cast true. Nothing downstream
 * would refuse such a value. The seed hands it to Prisma's Json column write,
 * which is `JSON.stringify` under a replacer: a `Date` becomes its ISO
 * string, a `bigint` a string of digits, an `undefined` member is dropped and
 * a hole is written as `null`. The ability factory then renders the row it
 * read back, never the catalog object, so the filter would reach a query
 * silently changed. Names the slug and the path.
 */
export function assertJsonConditions(catalog: readonly PermissionSeedDefinition[]): void {
  for (const { slug, conditions } of catalog) {
    if (conditions !== undefined) {
      assertJsonValue(conditions, slug, 'conditions');
    }
  }
}

function assertJsonValue(value: unknown, slug: string, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return;
  }

  if (Array.isArray(value)) {
    // `entries()` visits a hole as `undefined`; `forEach` would skip it.
    for (const [index, item] of value.entries()) {
      assertJsonValue(item, slug, `${path}[${index}]`);
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, member] of Object.entries(value)) {
      assertJsonValue(member, slug, `${path}.${key}`);
    }
    return;
  }

  throw new Error(`Permission '${slug}' has a value at ${path} that is not JSON as written (${describeValue(value)})`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    // A prototype chain that never reaches Object.prototype has no
    // `constructor`; the message must not throw on the value it reports.
    const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === 'string' && name !== '' ? name : 'object';
  }

  return typeof value === 'number' ? String(value) : typeof value;
}

/**
 * Every key of the role→slugs map is a `SystemRole` member, and every slug it
 * lists is defined by the permission catalog exactly once per role.
 */
export function assertRolePermissionCatalog(
  rolePermissions: Readonly<Record<string, readonly string[]>>,
  catalog: readonly PermissionSeedDefinition[],
): void {
  const defined = new Set(catalog.map(({ slug }) => slug));

  for (const [roleName, slugs] of Object.entries(rolePermissions)) {
    if (!SYSTEM_ROLES.has(roleName)) {
      throw new Error(`Role-permission catalog names role '${roleName}', which is not a SystemRole member`);
    }

    const listed = new Set<string>();
    for (const slug of slugs) {
      if (!defined.has(slug)) {
        throw new Error(`Role '${roleName}' references slug '${slug}', which the permission catalog does not define`);
      }

      if (listed.has(slug)) {
        throw new Error(`Role '${roleName}' lists slug '${slug}' more than once`);
      }

      listed.add(slug);
    }
  }
}

/**
 * Every `SystemRole` member is seeded exactly once. `ROLE_PERMISSION_CATALOG`
 * and `ROLE_SCOPE` are keyed by `SystemRole`, so the compiler forces an entry
 * for a new enum member there — but the role catalog is a list, and a member
 * missing from it would reach the seed as a role to grant permissions to that
 * was never written.
 */
export function assertEveryRoleSeeded(roles: readonly RoleSeedDefinition[]): void {
  const seeded = new Set<string>();
  for (const { name } of roles) {
    if (seeded.has(name)) {
      throw new Error(`Role catalog seeds role '${name}' more than once`);
    }
    seeded.add(name);
  }

  for (const role of SYSTEM_ROLES) {
    if (!seeded.has(role)) {
      throw new Error(`Role catalog does not seed SystemRole member '${role}'`);
    }
  }
}
